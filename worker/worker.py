"""
AirTranslate Worker (v4)
主循环：通过服务端 API 获取队列/更新进度，只直连 COS 下载/上传 EPUB。
"""

import json
import logging
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

load_dotenv()

import epub_util
import translators

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
)
log = logging.getLogger("worker")

SERVER_URL = os.environ.get("SERVER_URL", "http://localhost:9001").rstrip("/")
WORKER_API_KEY = os.environ.get("WORKER_API_KEY", "")
POLL_INTERVAL = int(os.getenv("POLL_INTERVAL_SEC", "10"))


# ---------------------------------------------------------------------------
# 服务端 API 辅助
# ---------------------------------------------------------------------------

def _api_headers() -> dict:
    """构建请求头"""
    headers = {"Content-Type": "application/json"}
    if WORKER_API_KEY:
        headers["X-Worker-Key"] = WORKER_API_KEY
    return headers


def api_poll() -> dict | None:
    """GET /worker/poll — 获取下一个待处理任务"""
    try:
        resp = httpx.get(
            f"{SERVER_URL}/worker/poll",
            headers=_api_headers(),
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("jobId"):
            return data
        return None
    except Exception as e:
        log.warning("api_poll failed: %s", e)
        return None


def api_progress(job_id: str, **kwargs) -> None:
    """POST /worker/progress — 更新任务进度"""
    try:
        body = {"jobId": job_id, **kwargs}
        resp = httpx.post(
            f"{SERVER_URL}/worker/progress",
            headers=_api_headers(),
            json=body,
            timeout=10,
        )
        resp.raise_for_status()
    except Exception as e:
        log.warning("api_progress(%s) failed: %s", job_id, e)


def api_complete(job_id: str) -> None:
    """POST /worker/complete — 标记任务完成"""
    try:
        resp = httpx.post(
            f"{SERVER_URL}/worker/complete",
            headers=_api_headers(),
            json={"jobId": job_id},
            timeout=10,
        )
        resp.raise_for_status()
    except Exception as e:
        log.warning("api_complete(%s) failed: %s", job_id, e)


def api_fail(job_id: str, error_msg: str) -> None:
    """POST /worker/fail — 标记任务失败"""
    try:
        resp = httpx.post(
            f"{SERVER_URL}/worker/fail",
            headers=_api_headers(),
            json={
                "jobId": job_id,
                "error": {"code": "JOB_FAILED", "message": error_msg},
            },
            timeout=10,
        )
        resp.raise_for_status()
    except Exception as e:
        log.warning("api_fail(%s) failed: %s", job_id, e)


# ---------------------------------------------------------------------------
# COS presign URL 文件操作
# ---------------------------------------------------------------------------

def download_presign(url: str, local_path: str) -> None:
    """通过 presign URL 下载文件"""
    with httpx.stream("GET", url, timeout=300, follow_redirects=True) as resp:
        resp.raise_for_status()
        with open(local_path, "wb") as f:
            for chunk in resp.iter_bytes(chunk_size=65536):
                f.write(chunk)


def upload_presign(url: str, local_path: str, content_type: str = "application/epub+zip") -> None:
    """通过 presign URL 上传文件"""
    file_size = os.path.getsize(local_path)
    with open(local_path, "rb") as f:
        resp = httpx.put(
            url,
            content=f,
            headers={
                "Content-Type": content_type,
                "Content-Length": str(file_size),
            },
            timeout=300,
        )
        resp.raise_for_status()


def download_glossary(url: str) -> dict | None:
    """通过 presign URL 下载术语表 JSON"""
    try:
        resp = httpx.get(url, timeout=15, follow_redirects=True)
        if resp.status_code == 200:
            data = resp.json()
            if isinstance(data, dict):
                log.info("Loaded glossary with %d entries", len(data))
                return data
    except Exception as e:
        log.warning("download_glossary failed: %s", e)
    return None


# ---------------------------------------------------------------------------
# 任务处理
# ---------------------------------------------------------------------------

def process_job(poll_data: dict) -> None:
    """处理单个翻译任务"""
    job_id = poll_data["jobId"]
    job = poll_data["job"]
    cos_urls = poll_data["cos"]
    temp_dir = None

    try:
        log.info("=== Processing job %s ===", job_id)

        engine_type = job.get("engineType", "MACHINE")
        src_lang = job.get("sourceLang", "auto")
        tgt_lang = job.get("targetLang", "zh")
        output_mode = job.get("output", "BILINGUAL")
        use_context = job.get("useContext", False)

        api_progress(job_id, state="PARSING", percent=1)

        # 创建临时目录
        temp_dir = tempfile.mkdtemp(prefix=f"job_{job_id[:8]}_")
        source_epub = os.path.join(temp_dir, "source.epub")
        unpack_dir = os.path.join(temp_dir, "unpacked")

        # 下载 EPUB (通过 presign URL)
        log.info("Downloading source EPUB...")
        download_presign(cos_urls["sourceDownloadUrl"], source_epub)

        # 解压
        log.info("Unpacking EPUB...")
        epub_util.unzip_epub(source_epub, unpack_dir)

        # 加载术语表 (仅 AI 翻译)
        glossary = None
        if engine_type == "AI" and cos_urls.get("glossaryDownloadUrl"):
            glossary = download_glossary(cos_urls["glossaryDownloadUrl"])

        # 查找 HTML 文件
        html_files = epub_util.find_html_files(unpack_dir)
        if not html_files:
            log.warning("No HTML files found in EPUB")
            api_complete(job_id)
            return

        log.info("Found %d HTML files to translate", len(html_files))
        api_progress(
            job_id,
            state="TRANSLATING",
            percent=2,
            engineType=engine_type,
            output=output_mode,
            chapterTotal=len(html_files),
        )

        # 翻译每个 HTML 文件
        context_buffer = ""
        for i, html_path in enumerate(html_files):
            chapter_num = i + 1
            log.info("Translating chapter %d/%d: %s", chapter_num, len(html_files), Path(html_path).name)

            original_texts = epub_util.extract_texts(html_path)
            if not original_texts:
                log.info("  No translatable text, skipping")
                continue

            log.info("  Found %d segments to translate", len(original_texts))
            chapter_start = time.time()

            # 翻译
            if engine_type == "AI":
                ctx = context_buffer if use_context else None
                translated_texts = translators.translate_ai(
                    original_texts, src_lang, tgt_lang, ctx, glossary,
                )
                if use_context:
                    context_buffer = _update_context(context_buffer, translated_texts)
            else:
                translated_texts = translators.translate_machine(
                    original_texts, src_lang, tgt_lang,
                )

            chapter_elapsed = time.time() - chapter_start
            log.info("  Chapter %d/%d translated in %.1fs (%d segments)",
                     chapter_num, len(html_files), chapter_elapsed, len(original_texts))

            # 回写
            epub_util.write_back(html_path, original_texts, translated_texts, output_mode)

            # 更新进度
            percent = min(99, max(3, int((chapter_num / len(html_files)) * 100)))
            api_progress(
                job_id,
                state="TRANSLATING",
                percent=percent,
                chapterIndex=chapter_num,
                chapterTotal=len(html_files),
            )

        # 重打包
        log.info("Repacking EPUB...")
        api_progress(job_id, state="PACKAGING", percent=99)
        result_epub = os.path.join(temp_dir, "result.epub")
        epub_util.zip_epub(unpack_dir, result_epub)

        # 上传结果 (通过 presign URL)
        log.info("Uploading result...")
        api_progress(job_id, state="UPLOADING_RESULT", percent=99)
        if output_mode.upper() == "BILINGUAL":
            upload_presign(cos_urls["bilingualUploadUrl"], result_epub)
        else:
            upload_presign(cos_urls["translatedUploadUrl"], result_epub)

        # 完成
        api_complete(job_id)
        log.info("=== Job %s DONE ===", job_id)

    except Exception as e:
        log.error("Job %s FAILED: %s", job_id, e, exc_info=True)
        api_fail(job_id, str(e))

    finally:
        # 清理临时目录
        if temp_dir and os.path.exists(temp_dir):
            try:
                shutil.rmtree(temp_dir)
            except Exception:
                pass


# ---------------------------------------------------------------------------
# 辅助
# ---------------------------------------------------------------------------

def _update_context(current_context: str, translated_texts: list[str]) -> str:
    """更新上下文缓冲：保留最近约 500 字"""
    new_text = "\n".join(t for t in translated_texts if t)
    combined = current_context + "\n" + new_text if current_context else new_text
    if len(combined) > 500:
        combined = combined[-500:]
    return combined


# ---------------------------------------------------------------------------
# 主循环
# ---------------------------------------------------------------------------

def main():
    log.info("AirTranslate Worker started. Poll interval: %ds", POLL_INTERVAL)
    log.info("Server URL: %s", SERVER_URL)

    while True:
        try:
            poll_data = api_poll()
            if poll_data:
                process_job(poll_data)
            else:
                time.sleep(POLL_INTERVAL)
        except KeyboardInterrupt:
            log.info("Worker stopped by user")
            sys.exit(0)
        except Exception as e:
            log.error("Poll loop error: %s", e, exc_info=True)
            time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
