"""
AirTranslate Worker (v5) — 公平轮询调度
- 窗口大小 WINDOW=5，同时管理多个翻译任务
- 机器翻译并发 MACHINE_CONCURRENCY=2，AI 翻译串行(GPU 独占)
- 每个任务每轮翻译一个章节(HTML 文件)，轮询公平调度
"""

import json
import logging
import os
import shutil
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

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
WINDOW_SIZE = int(os.getenv("SCHEDULER_WINDOW", "5"))
MACHINE_CONCURRENCY = int(os.getenv("MACHINE_CONCURRENCY", "2"))


# ---------------------------------------------------------------------------
# 服务端 API 辅助
# ---------------------------------------------------------------------------

def _api_headers() -> dict:
    headers = {"Content-Type": "application/json"}
    if WORKER_API_KEY:
        headers["X-Worker-Key"] = WORKER_API_KEY
    return headers


_poll_batch_available = True  # 降级标志：首次 404 后自动降级为单任务轮询

def api_poll_batch(limit: int = WINDOW_SIZE) -> list[dict]:
    """GET /worker/poll-batch — 批量获取待处理任务，服务端不支持时降级为 poll"""
    global _poll_batch_available

    # 优先使用 batch 接口
    if _poll_batch_available:
        try:
            resp = httpx.get(
                f"{SERVER_URL}/worker/poll-batch",
                params={"limit": str(limit)},
                headers=_api_headers(),
                timeout=15,
            )
            if resp.status_code == 404:
                log.info("Server does not support poll-batch, falling back to single poll")
                _poll_batch_available = False
            else:
                resp.raise_for_status()
                data = resp.json()
                return data.get("jobs") or []
        except Exception as e:
            log.warning("api_poll_batch failed: %s", e)
            return []

    # 降级: 使用旧的单任务 poll 接口
    try:
        resp = httpx.get(
            f"{SERVER_URL}/worker/poll",
            headers=_api_headers(),
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("jobId"):
            return [data]
        return []
    except Exception as e:
        log.warning("api_poll (fallback) failed: %s", e)
        return []


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
    with httpx.stream("GET", url, timeout=300, follow_redirects=True) as resp:
        resp.raise_for_status()
        with open(local_path, "wb") as f:
            for chunk in resp.iter_bytes(chunk_size=65536):
                f.write(chunk)


def upload_presign(url: str, local_path: str, content_type: str = "application/epub+zip") -> None:
    file_size = os.path.getsize(local_path)
    with open(local_path, "rb") as f:
        resp = httpx.put(
            url,
            content=f,
            headers={"Content-Type": content_type, "Content-Length": str(file_size)},
            timeout=300,
        )
        resp.raise_for_status()


def download_glossary(url: str) -> dict | None:
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
# 任务状态 (在 Worker 内存中维护)
# ---------------------------------------------------------------------------

@dataclass
class JobState:
    """单个翻译任务的运行时状态"""
    job_id: str
    poll_data: dict              # 原始 poll 数据 (job, cos)
    engine_type: str = "MACHINE"
    src_lang: str = "auto"
    tgt_lang: str = "zh"
    output_mode: str = "BILINGUAL"
    use_context: bool = False
    translate_mode: str = "PARAGRAPH"  # PARAGRAPH or CHAPTER
    glossary: Optional[dict] = None

    temp_dir: Optional[str] = None
    unpack_dir: Optional[str] = None
    html_files: list[str] = field(default_factory=list)
    chapter_index: int = 0       # 下一个要翻译的章节索引
    context_pairs: list[tuple[str, str]] = field(default_factory=list)  # (source, translation) pairs
    prepared: bool = False       # 是否已下载/解压完成
    finished: bool = False       # 翻译是否全部完成
    failed: bool = False

    @property
    def chapter_total(self) -> int:
        return len(self.html_files)

    @property
    def has_next_chapter(self) -> bool:
        return self.chapter_index < self.chapter_total

    def cleanup(self):
        if self.temp_dir and os.path.exists(self.temp_dir):
            try:
                shutil.rmtree(self.temp_dir)
            except Exception:
                pass


# ---------------------------------------------------------------------------
# 准备任务 (下载 + 解压 + 查找 HTML)
# ---------------------------------------------------------------------------

def prepare_job(state: JobState) -> None:
    """下载 EPUB、解压、解析 HTML 文件列表"""
    job = state.poll_data["job"]
    cos_urls = state.poll_data["cos"]

    state.engine_type = job.get("engineType", "MACHINE")
    state.src_lang = job.get("sourceLang", "auto")
    state.tgt_lang = job.get("targetLang", "zh")
    state.output_mode = job.get("output", "BILINGUAL")
    state.use_context = job.get("useContext", False)
    state.translate_mode = job.get("translateMode", "PARAGRAPH")

    api_progress(state.job_id, state="PARSING", percent=1)

    state.temp_dir = tempfile.mkdtemp(prefix=f"job_{state.job_id[:8]}_")
    source_epub = os.path.join(state.temp_dir, "source.epub")
    state.unpack_dir = os.path.join(state.temp_dir, "unpacked")

    log.info("[%s] Downloading source EPUB...", state.job_id[:8])
    download_presign(cos_urls["sourceDownloadUrl"], source_epub)

    log.info("[%s] Unpacking EPUB...", state.job_id[:8])
    epub_util.unzip_epub(source_epub, state.unpack_dir)

    if state.engine_type == "AI" and cos_urls.get("glossaryDownloadUrl"):
        state.glossary = download_glossary(cos_urls["glossaryDownloadUrl"])

    state.html_files = epub_util.find_html_files(state.unpack_dir)
    if not state.html_files:
        log.warning("[%s] No HTML files found in EPUB", state.job_id[:8])
        api_complete(state.job_id)
        state.finished = True
        return

    log.info("[%s] Found %d HTML files to translate", state.job_id[:8], len(state.html_files))
    api_progress(
        state.job_id,
        state="TRANSLATING",
        percent=2,
        engineType=state.engine_type,
        output=state.output_mode,
        chapterTotal=len(state.html_files),
    )
    state.prepared = True


# ---------------------------------------------------------------------------
# 翻译单个章节
# ---------------------------------------------------------------------------

def translate_one_chapter(state: JobState) -> None:
    """翻译 state 中的下一个章节，并更新 chapter_index"""
    if not state.has_next_chapter:
        return

    idx = state.chapter_index
    html_path = state.html_files[idx]
    chapter_num = idx + 1
    tag = state.job_id[:8]

    log.info("[%s] Translating chapter %d/%d: %s",
             tag, chapter_num, state.chapter_total, Path(html_path).name)

    original_texts = epub_util.extract_texts(html_path)
    if not original_texts:
        log.info("[%s]   No translatable text, skipping chapter %d", tag, chapter_num)
        state.chapter_index += 1
        return

    log.info("[%s]   %d segments", tag, len(original_texts))
    chapter_start = time.time()

    if state.engine_type == "AI":
        ctx = _render_context(state.context_pairs) if state.use_context else None
        if state.translate_mode == "CHAPTER":
            translated_texts = translators.translate_ai_chapter(
                original_texts, state.src_lang, state.tgt_lang, ctx, state.glossary,
            )
        else:
            translated_texts = translators.translate_ai(
                original_texts, state.src_lang, state.tgt_lang, ctx, state.glossary,
            )
        if state.use_context:
            _update_context_pairs(state.context_pairs, original_texts, translated_texts)
    else:
        translated_texts = translators.translate_machine(
            original_texts, state.src_lang, state.tgt_lang,
        )

    elapsed = time.time() - chapter_start
    log.info("[%s]   Chapter %d/%d done in %.1fs",
             tag, chapter_num, state.chapter_total, elapsed)

    epub_util.write_back(html_path, original_texts, translated_texts, state.output_mode)

    state.chapter_index += 1

    percent = min(99, max(3, int((state.chapter_index / state.chapter_total) * 100)))
    api_progress(
        state.job_id,
        state="TRANSLATING",
        percent=percent,
        chapterIndex=state.chapter_index,
        chapterTotal=state.chapter_total,
    )


# ---------------------------------------------------------------------------
# 完成任务 (打包 + 上传)
# ---------------------------------------------------------------------------

def finalize_job(state: JobState) -> None:
    """重打包 EPUB 并上传结果"""
    tag = state.job_id[:8]
    cos_urls = state.poll_data["cos"]

    log.info("[%s] Repacking EPUB...", tag)
    api_progress(state.job_id, state="PACKAGING", percent=99)
    result_epub = os.path.join(state.temp_dir, "result.epub")
    epub_util.zip_epub(state.unpack_dir, result_epub)

    log.info("[%s] Uploading result...", tag)
    api_progress(state.job_id, state="UPLOADING_RESULT", percent=99)
    if state.output_mode.upper() == "BILINGUAL":
        upload_presign(cos_urls["bilingualUploadUrl"], result_epub)
    else:
        upload_presign(cos_urls["translatedUploadUrl"], result_epub)

    api_complete(state.job_id)
    state.finished = True
    log.info("[%s] === DONE ===", tag)


# ---------------------------------------------------------------------------
# 辅助
# ---------------------------------------------------------------------------

def _update_context_pairs(
    pairs: list[tuple[str, str]],
    originals: list[str],
    translations: list[str],
) -> None:
    """追加 source→translation 对到上下文缓冲，并按 token 预算截断。

    策略:
    - 每对存储格式: "原文\n译文" (模型能看到原文和对应翻译，保持术语一致性)
    - 只保留最近的 N 对，使渲染后总字符数 <= _CONTEXT_CHAR_BUDGET
    - 从尾部保留（最近的上下文最重要）
    """
    for src, tgt in zip(originals, translations):
        if src and src.strip() and tgt and tgt.strip():
            pairs.append((src.strip(), tgt.strip()))

    # 从最新的 pair 开始反向累加，直到超出预算
    budget = translators._CONTEXT_CHAR_BUDGET
    total = 0
    keep_from = len(pairs)
    for i in range(len(pairs) - 1, -1, -1):
        pair_len = len(pairs[i][0]) + len(pairs[i][1]) + 2  # +2 for separators
        if total + pair_len > budget:
            break
        total += pair_len
        keep_from = i

    # 截断旧的
    if keep_from > 0:
        del pairs[:keep_from]


def _render_context(pairs: list[tuple[str, str]]) -> str | None:
    """将 source→translation 对渲染为上下文字符串。

    格式: 每对用换行分隔，原文和译文之间也用换行分隔。
    模型能看到前文的原文和翻译，有助于保持术语一致和语境连贯。
    """
    if not pairs:
        return None
    lines = []
    for src, tgt in pairs:
        lines.append(f"{src}\n{tgt}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 公平轮询调度器
# ---------------------------------------------------------------------------

class Scheduler:
    """窗口 = WINDOW_SIZE 的公平轮询调度器"""

    def __init__(self):
        self.active: dict[str, JobState] = {}   # job_id -> JobState
        self.round_robin_order: list[str] = []   # 轮询顺序
        self.machine_pool = ThreadPoolExecutor(max_workers=MACHINE_CONCURRENCY)

    def poll_and_update_window(self) -> None:
        """从服务端拉取队列，填充窗口至 WINDOW_SIZE"""
        need = WINDOW_SIZE - len(self.active)
        if need <= 0:
            return

        batch = api_poll_batch(limit=WINDOW_SIZE)
        for item in batch:
            jid = item["jobId"]
            if jid in self.active:
                continue
            state = JobState(job_id=jid, poll_data=item)
            try:
                prepare_job(state)
            except Exception as e:
                log.error("[%s] Prepare failed: %s", jid[:8], e, exc_info=True)
                api_fail(jid, str(e))
                state.cleanup()
                continue

            if state.finished:
                state.cleanup()
                continue

            self.active[jid] = state
            self.round_robin_order.append(jid)
            log.info("[Scheduler] Added job %s to window (%d/%d)",
                     jid[:8], len(self.active), WINDOW_SIZE)

            if len(self.active) >= WINDOW_SIZE:
                break

    def _remove_job(self, jid: str) -> None:
        """从活跃窗口中移除任务"""
        state = self.active.pop(jid, None)
        if jid in self.round_robin_order:
            self.round_robin_order.remove(jid)
        if state:
            state.cleanup()

    def run_one_round(self) -> bool:
        """执行一轮调度：每个活跃任务翻译一个章节。
        返回 True 如果本轮有工作完成（无需 sleep）。
        """
        if not self.round_robin_order:
            return False

        did_work = False
        # 拍快照避免迭代中修改
        order_snapshot = list(self.round_robin_order)

        # 分组: AI 任务和机器翻译任务
        ai_jobs = []
        machine_jobs = []
        for jid in order_snapshot:
            state = self.active.get(jid)
            if not state or state.finished or state.failed:
                continue
            if not state.has_next_chapter:
                continue
            if state.engine_type == "AI":
                ai_jobs.append(jid)
            else:
                machine_jobs.append(jid)

        # 机器翻译: 并发执行 (每个任务翻译一个章节)
        if machine_jobs:
            futures = {}
            for jid in machine_jobs:
                state = self.active[jid]
                future = self.machine_pool.submit(translate_one_chapter, state)
                futures[future] = jid
            for future in as_completed(futures):
                jid = futures[future]
                try:
                    future.result()
                    did_work = True
                except Exception as e:
                    log.error("[%s] Machine chapter failed: %s", jid[:8], e, exc_info=True)
                    api_fail(jid, str(e))
                    self.active[jid].failed = True

        # AI 翻译: 串行执行 (每个任务翻译一个章节)
        for jid in ai_jobs:
            state = self.active[jid]
            try:
                translate_one_chapter(state)
                did_work = True
            except Exception as e:
                log.error("[%s] AI chapter failed: %s", jid[:8], e, exc_info=True)
                api_fail(jid, str(e))
                state.failed = True

        # 检查已完成和失败的任务
        to_remove = []
        for jid in list(self.active.keys()):
            state = self.active[jid]
            if state.failed:
                to_remove.append(jid)
                continue
            if not state.has_next_chapter and not state.finished:
                try:
                    finalize_job(state)
                except Exception as e:
                    log.error("[%s] Finalize failed: %s", jid[:8], e, exc_info=True)
                    api_fail(jid, str(e))
                to_remove.append(jid)

        for jid in to_remove:
            self._remove_job(jid)

        return did_work

    def shutdown(self):
        """清理所有活跃任务"""
        for jid in list(self.active.keys()):
            self.active[jid].cleanup()
        self.active.clear()
        self.round_robin_order.clear()
        self.machine_pool.shutdown(wait=False)


# ---------------------------------------------------------------------------
# 主循环
# ---------------------------------------------------------------------------

def main():
    log.info("AirTranslate Worker v5 started (window=%d, machine_concurrency=%d)",
             WINDOW_SIZE, MACHINE_CONCURRENCY)
    log.info("Server URL: %s", SERVER_URL)

    scheduler = Scheduler()

    while True:
        try:
            # 填充窗口
            scheduler.poll_and_update_window()

            if scheduler.active:
                # 执行一轮
                did_work = scheduler.run_one_round()
                if not did_work:
                    time.sleep(1)
            else:
                time.sleep(POLL_INTERVAL)
        except KeyboardInterrupt:
            log.info("Worker stopped by user")
            scheduler.shutdown()
            sys.exit(0)
        except Exception as e:
            log.error("Scheduler loop error: %s", e, exc_info=True)
            time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
