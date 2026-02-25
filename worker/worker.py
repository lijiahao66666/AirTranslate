"""
AirTranslate Worker
主循环：轮询 COS 队列 → 下载 EPUB → 翻译 → 上传结果
直接操作 COS，不经过 SCF。
"""

import json
import logging
import os
import shutil
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from qcloud_cos import CosConfig, CosS3Client

import epub_util
import translators

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
)
log = logging.getLogger("worker")

COS_SECRET_ID = os.environ["COS_SECRET_ID"]
COS_SECRET_KEY = os.environ["COS_SECRET_KEY"]
COS_BUCKET = os.environ["COS_BUCKET"]
COS_REGION = os.environ["COS_REGION"]
POLL_INTERVAL = int(os.getenv("POLL_INTERVAL_SEC", "10"))

config = CosConfig(
    Region=COS_REGION,
    SecretId=COS_SECRET_ID,
    SecretKey=COS_SECRET_KEY,
)
cos = CosS3Client(config)


# ---------------------------------------------------------------------------
# COS 辅助函数
# ---------------------------------------------------------------------------

def cos_get_json(key: str) -> dict | None:
    """从 COS 读取 JSON 对象"""
    try:
        resp = cos.get_object(Bucket=COS_BUCKET, Key=key)
        body = resp["Body"].get_raw_stream().read()
        return json.loads(body)
    except Exception as e:
        log.warning("cos_get_json(%s) failed: %s", key, e)
        return None


def cos_put_json(key: str, data: dict) -> None:
    """写入 JSON 对象到 COS"""
    body = json.dumps(data, ensure_ascii=False)
    cos.put_object(Bucket=COS_BUCKET, Key=key, Body=body.encode("utf-8"))


def cos_download(key: str, local_path: str) -> None:
    """从 COS 下载文件到本地"""
    cos.download_file(Bucket=COS_BUCKET, Key=key, DestFilePath=local_path)


def cos_upload(key: str, local_path: str) -> None:
    """上传本地文件到 COS"""
    cos.upload_file(Bucket=COS_BUCKET, Key=key, LocalFilePath=local_path)


def cos_delete(key: str) -> None:
    """删除 COS 对象"""
    try:
        cos.delete_object(Bucket=COS_BUCKET, Key=key)
    except Exception as e:
        log.warning("cos_delete(%s) failed: %s", key, e)


def cos_list_prefix(prefix: str) -> list[str]:
    """列出 COS 指定前缀下的所有 key"""
    keys = []
    marker = ""
    while True:
        resp = cos.list_objects(
            Bucket=COS_BUCKET, Prefix=prefix, Marker=marker, MaxKeys=100,
        )
        contents = resp.get("Contents", [])
        for item in contents:
            keys.append(item["Key"])
        if resp.get("IsTruncated") == "true":
            marker = resp.get("NextMarker", "")
        else:
            break
    return keys


# ---------------------------------------------------------------------------
# 队列轮询
# ---------------------------------------------------------------------------

def poll_next_job_id() -> str | None:
    """从 COS 队列中取出一个待处理的 job_id"""
    keys = cos_list_prefix("jobs/_queue/pending/")
    for key in keys:
        # key 形如 "jobs/_queue/pending/{jobId}"
        parts = key.split("/")
        if len(parts) >= 4 and parts[3]:
            return parts[3]
    return None


# ---------------------------------------------------------------------------
# 进度管理
# ---------------------------------------------------------------------------

def update_progress(job_id: str, **kwargs) -> None:
    """更新任务进度 JSON"""
    key = f"jobs/{job_id}/progress.json"
    progress = cos_get_json(key) or {}
    progress.update(kwargs)
    progress["updatedAt"] = datetime.now(timezone.utc).isoformat()
    cos_put_json(key, progress)


# ---------------------------------------------------------------------------
# 任务处理
# ---------------------------------------------------------------------------

def process_job(job_id: str) -> None:
    """处理单个翻译任务"""
    temp_dir = None
    try:
        log.info("=== Processing job %s ===", job_id)

        # 读取任务规格
        job = cos_get_json(f"jobs/{job_id}/job.json")
        if not job:
            log.error("Job spec not found: %s", job_id)
            return

        # 检查进度状态
        progress = cos_get_json(f"jobs/{job_id}/progress.json") or {}
        state = progress.get("state", "CREATED")
        if state in ("DONE", "CANCELED"):
            log.info("Job %s already %s, skipping", job_id, state)
            cos_delete(f"jobs/_queue/pending/{job_id}")
            return

        engine_type = job.get("engineType", "MACHINE")  # "MACHINE" 或 "AI"
        src_lang = job.get("sourceLang", "auto")
        tgt_lang = job.get("targetLang", "zh")
        output_mode = job.get("output", "BILINGUAL")
        use_context = job.get("useContext", False)

        update_progress(job_id, state="PARSING", percent=1)

        # 创建临时目录
        temp_dir = tempfile.mkdtemp(prefix=f"job_{job_id}_")
        source_epub = os.path.join(temp_dir, "source.epub")
        unpack_dir = os.path.join(temp_dir, "unpacked")

        # 下载 EPUB
        log.info("Downloading source EPUB...")
        cos_download(f"jobs/{job_id}/source/source.epub", source_epub)

        # 解压
        log.info("Unpacking EPUB...")
        epub_util.unzip_epub(source_epub, unpack_dir)

        # 加载术语表 (仅 AI 翻译)
        glossary = None
        if engine_type == "AI":
            glossary = _load_glossary(job_id)

        # 查找 HTML 文件
        html_files = epub_util.find_html_files(unpack_dir)
        if not html_files:
            log.warning("No HTML files found in EPUB")
            update_progress(job_id, state="DONE", percent=100)
            cos_delete(f"jobs/_queue/pending/{job_id}")
            return

        log.info("Found %d HTML files to translate", len(html_files))
        update_progress(
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

            # 翻译
            if engine_type == "AI":
                ctx = context_buffer if use_context else None
                translated_texts = translators.translate_ai(
                    original_texts, src_lang, tgt_lang, ctx, glossary,
                )
                # 更新上下文：取最后几段翻译结果
                if use_context:
                    context_buffer = _update_context(context_buffer, translated_texts)
            else:
                translated_texts = translators.translate_machine(
                    original_texts, src_lang, tgt_lang,
                )

            # 回写
            epub_util.write_back(html_path, original_texts, translated_texts, output_mode)

            # 更新进度
            percent = min(99, max(3, int((chapter_num / len(html_files)) * 100)))
            update_progress(
                job_id,
                state="TRANSLATING",
                percent=percent,
                chapterIndex=chapter_num,
                chapterTotal=len(html_files),
            )

        # 重打包
        log.info("Repacking EPUB...")
        update_progress(job_id, state="PACKAGING", percent=99)
        result_epub = os.path.join(temp_dir, "result.epub")
        epub_util.zip_epub(unpack_dir, result_epub)

        # 上传结果
        log.info("Uploading result...")
        update_progress(job_id, state="UPLOADING_RESULT", percent=99)
        result_name = "bilingual.epub" if output_mode.upper() == "BILINGUAL" else "translated.epub"
        cos_upload(f"jobs/{job_id}/result/{result_name}", result_epub)

        # 完成
        update_progress(job_id, state="DONE", percent=100)
        cos_delete(f"jobs/_queue/pending/{job_id}")
        log.info("=== Job %s DONE ===", job_id)

    except Exception as e:
        log.error("Job %s FAILED: %s", job_id, e, exc_info=True)
        try:
            update_progress(
                job_id,
                state="FAILED",
                error={"code": "JOB_FAILED", "message": str(e)},
            )
        except Exception:
            pass


# ---------------------------------------------------------------------------
# 辅助
# ---------------------------------------------------------------------------

def _load_glossary(job_id: str) -> dict | None:
    """从 COS 加载术语表"""
    data = cos_get_json(f"jobs/{job_id}/glossary.json")
    if data and isinstance(data, dict):
        log.info("Loaded glossary with %d entries", len(data))
        return data
    return None


def _update_context(current_context: str, translated_texts: list[str]) -> str:
    """更新上下文缓冲：保留最近约 500 字"""
    new_text = "\n".join(t for t in translated_texts if t)
    combined = current_context + "\n" + new_text if current_context else new_text
    # 保留最后 500 字
    if len(combined) > 500:
        combined = combined[-500:]
    return combined


# ---------------------------------------------------------------------------
# 主循环
# ---------------------------------------------------------------------------

def main():
    log.info("AirTranslate Worker started. Poll interval: %ds", POLL_INTERVAL)
    log.info("COS Bucket: %s, Region: %s", COS_BUCKET, COS_REGION)
    log.info("vLLM URL: %s", translators.VLLM_BASE_URL)

    while True:
        try:
            job_id = poll_next_job_id()
            if job_id:
                process_job(job_id)
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
