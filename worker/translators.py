"""
翻译引擎模块
- 机器翻译：Azure Edge → MyMemory → Google (链式退避，国内优先)
- AI翻译：vLLM OpenAI-compatible API（支持上下文 + 术语表）
"""

import logging
import os
import time
from typing import Optional

import httpx

log = logging.getLogger(__name__)

MYMEMORY_EMAIL = os.getenv("MYMEMORY_EMAIL", "")

# ---------------------------------------------------------------------------
# 自定义异常
# ---------------------------------------------------------------------------

class TranslateError(Exception):
    """翻译失败异常"""
    pass


# ---------------------------------------------------------------------------
# 机器翻译：链式退避 Azure → MyMemory → Google
# ---------------------------------------------------------------------------

def translate_machine(texts: list[str], src_lang: str, tgt_lang: str) -> list[str]:
    """机器翻译：三引擎链式退避（国内优先）"""
    engines = [
        ("azure",    _translate_azure),
        ("mymemory", _translate_mymemory),
        ("google",   _translate_google),
    ]
    last_err = None
    for name, engine_fn in engines:
        try:
            result = engine_fn(texts, src_lang, tgt_lang)
            log.info("Machine translate OK via %s (%d texts)", name, len(texts))
            return result
        except Exception as e:
            last_err = e
            log.warning("%s failed: %s, trying next...", name, e)
            continue
    raise TranslateError(f"All machine translation engines failed. Last error: {last_err}")


# ---------------------------------------------------------------------------
# Azure Edge Translate (免费, 国内可用)
# ---------------------------------------------------------------------------

_azure_token_cache: dict = {"token": None, "expires_at": 0.0}

_AZURE_LANG_MAP = {
    "en": "en", "fr": "fr", "de": "de", "es": "es", "ja": "ja",
    "it": "it", "ko": "ko", "pt": "pt-pt", "ar": "ar", "nl": "nl",
    "pl": "pl", "tr": "tr", "id": "id", "ru": "ru", "uk": "uk",
    "th": "th", "sv": "sv", "fi": "fi", "da": "da", "cs": "cs",
    "hu": "hu", "ro": "ro", "bg": "bg", "hr": "hr", "lt": "lt",
    "sl": "sl", "sk": "sk", "zh": "zh-Hans", "zh-cn": "zh-Hans",
    "zh-tw": "zh-Hant", "zh-hans": "zh-Hans", "zh-hant": "zh-Hant",
}


def _azure_get_token() -> str:
    now = time.time()
    if _azure_token_cache["token"] and _azure_token_cache["expires_at"] > now:
        return _azure_token_cache["token"]

    resp = httpx.get(
        "https://edge.microsoft.com/translate/auth",
        headers={"User-Agent": "Mozilla/5.0"},
        timeout=10,
    )
    resp.raise_for_status()
    token = resp.text.strip()
    _azure_token_cache["token"] = token
    _azure_token_cache["expires_at"] = now + 8 * 60  # 8 min
    return token


def _translate_azure(texts: list[str], src_lang: str, tgt_lang: str) -> list[str]:
    token = _azure_get_token()
    azure_tgt = _AZURE_LANG_MAP.get(tgt_lang.lower(), tgt_lang)

    body = [{"Text": t} for t in texts]
    resp = httpx.post(
        "https://api-edge.cognitive.microsofttranslator.com/translate",
        params={"to": azure_tgt, "api-version": "3.0"},
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        json=body,
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()

    results = []
    for i, item in enumerate(data):
        translations = item.get("translations", [])
        if translations:
            results.append(translations[0].get("text", texts[i]))
        else:
            results.append(texts[i])
    return results


# ---------------------------------------------------------------------------
# MyMemory (免费, 国内可用, 无需 key)
# ---------------------------------------------------------------------------

def _translate_mymemory(texts: list[str], src_lang: str, tgt_lang: str) -> list[str]:
    results = []
    for text in texts:
        if not text or not text.strip():
            results.append(text)
            continue

        params = {
            "q": text,
            "langpair": f"{src_lang}|{tgt_lang}",
        }
        if MYMEMORY_EMAIL:
            params["de"] = MYMEMORY_EMAIL

        resp = httpx.get(
            "https://api.mymemory.translated.net/get",
            params=params,
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()

        translated = data.get("responseData", {}).get("translatedText", "")
        if not translated or "MYMEMORY WARNING" in translated.upper():
            raise TranslateError(f"MyMemory limit reached or error: {translated}")
        results.append(translated)

    return results


# ---------------------------------------------------------------------------
# Google Translate (免费 web API, ⚠️ 国内需 VPN)
# ---------------------------------------------------------------------------

def _translate_google(texts: list[str], src_lang: str, tgt_lang: str) -> list[str]:
    results = []
    for text in texts:
        if not text or not text.strip():
            results.append(text)
            continue

        resp = httpx.post(
            "https://translate.googleapis.com/translate_a/single",
            data={
                "client": "gtx",
                "sl": src_lang if src_lang != "auto" else "auto",
                "tl": tgt_lang,
                "dt": "t",
                "q": text,
            },
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "Mozilla/5.0",
            },
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()

        # 解析 Google 响应: [[["translated","original",...], ...], ...]
        translated_parts = []
        if data and isinstance(data, list) and data[0]:
            for segment in data[0]:
                if isinstance(segment, list) and segment:
                    translated_parts.append(str(segment[0]))
        result = "".join(translated_parts) if translated_parts else text
        results.append(result)

    return results


# ---------------------------------------------------------------------------
# AI翻译：vLLM OpenAI-compatible API
# ---------------------------------------------------------------------------

# vLLM context = input + output, 由 VLLM_MAX_MODEL_LEN 控制
# Token 估算: 中文 ~1.5 tok/char, 英文 ~1.3 tok/char
# Prompt 指令/术语/上下文额外开销 ~200-400 tokens
_MAX_MODEL_LEN = int(os.getenv("VLLM_MAX_MODEL_LEN", "8192"))  # 与 start_vllm.sh 中 --max-model-len 保持一致

# 输入字符上限: 按 max_model_len 动态计算
# 保守策略: input 占 context 的 ~1/3, output 占 ~2/3
# 1 token ≈ 1.5 中文字符, 所以 max_input_tokens * 1.5 ≈ max_input_chars
_default_input_chars = str(int(_MAX_MODEL_LEN / 3 * 1.5))  # 段落
_default_chapter_chars = str(int(_MAX_MODEL_LEN / 3 * 1.5 * 2))  # 章节(可更大因为输出也更多)
_MAX_INPUT_CHARS = int(os.getenv("VLLM_MAX_INPUT_CHARS", _default_input_chars))
_MAX_CHAPTER_INPUT_CHARS = int(os.getenv("VLLM_MAX_CHAPTER_INPUT_CHARS", _default_chapter_chars))

# 上下文 token 预算: 占 max_model_len 的 1/4, 转换为字符数 (1 token ≈ 1.5 chars)
_CONTEXT_TOKEN_BUDGET = _MAX_MODEL_LEN // 4
_CONTEXT_CHAR_BUDGET = int(_CONTEXT_TOKEN_BUDGET * 1.5)

_VLLM_GEN_KWARGS = {
    "top_k": 20,
    "top_p": 0.6,
    "temperature": 0.7,
    "repetition_penalty": 1.05,
}


def _is_cn_involved(src_lang: str, tgt_lang: str) -> bool:
    """判断是否涉及中文"""
    cn_langs = {"zh", "zh-cn", "zh-tw", "zh-hans", "zh-hant"}
    return src_lang.lower() in cn_langs or tgt_lang.lower() in cn_langs


def _build_glossary_block(glossary: dict) -> str:
    """构建术语表块 (模型 README 格式)"""
    glossary_lines = "\n".join(
        f"{k} 翻译成 {v}" for k, v in glossary.items()
    )
    return f"参考下面的翻译：\n{glossary_lines}"


def _build_ai_prompt(
    text: str,
    src_lang: str,
    tgt_lang: str,
    context: Optional[str] = None,
    glossary: Optional[dict] = None,
) -> str:
    """构建 HY-MT1.5 翻译 prompt (严格遵循模型 README 模板)

    模板优先级:
    1. 术语 + 上下文: glossary_block + context + 指令 + source
    2. 仅术语: glossary_block + 指令 + source  (README: terminology)
    3. 仅上下文: context + 指令 + source  (README: contextual)
    4. 无: 指令 + source  (README: basic)
    """
    parts = []

    # 术语表 (放最前面)
    if glossary:
        parts.append(_build_glossary_block(glossary))

    # 上下文 + 指令
    if context:
        parts.append(context)
        # README: "参考上面的信息，把下面的文本翻译成{target_language}，注意不需要翻译上文，也不要额外解释："
        parts.append(f"参考上面的信息，把下面的文本翻译成{tgt_lang}，注意不需要翻译上文，也不要额外解释：")
    else:
        if _is_cn_involved(src_lang, tgt_lang):
            parts.append(f"将以下文本翻译为{tgt_lang}，注意只需要输出翻译后的结果，不要额外解释：")
        else:
            parts.append(f"Translate the following segment into {tgt_lang}, without additional explanation.")

    parts.append(text)
    return "\n\n".join(parts)


def translate_ai(
    texts: list[str],
    src_lang: str,
    tgt_lang: str,
    context: Optional[str] = None,
    glossary: Optional[dict] = None,
) -> list[str]:
    """AI翻译：通过 vLLM OpenAI-compatible API 推理"""
    vllm_url = os.getenv("VLLM_API_URL", "http://localhost:8000").rstrip("/")
    model_name = os.getenv("VLLM_MODEL_NAME", "HY-MT1.5")
    min_output_tokens = int(os.getenv("VLLM_MIN_OUTPUT_TOKENS", "256"))
    max_output_tokens = int(os.getenv("VLLM_MAX_OUTPUT_TOKENS", "4096"))
    # 硬上限: 不能超过 max_model_len 的一半 (留空间给 input)
    max_output_tokens = min(max_output_tokens, _MAX_MODEL_LEN // 2)
    if max_output_tokens < min_output_tokens:
        max_output_tokens = min_output_tokens

    results = []
    total = len(texts)
    log.info("[AI] Starting translation of %d segments via vLLM at %s", total, vllm_url)

    for i, text in enumerate(texts):
        if not text or not text.strip():
            results.append(text)
            log.info("[AI] Segment %d/%d: empty, skipped", i + 1, total)
            continue

        # 超长段落截断，避免溢出 max-model-len
        if len(text) > _MAX_INPUT_CHARS:
            log.warning("[AI] Segment %d/%d: %d chars exceeds limit %d, truncating",
                        i + 1, total, len(text), _MAX_INPUT_CHARS)
            text = text[:_MAX_INPUT_CHARS]

        seg_start = time.time()
        prompt = _build_ai_prompt(text, src_lang, tgt_lang, context, glossary)
        max_new = min(max(len(text) * 4, min_output_tokens), max_output_tokens)

        payload = {
            "model": model_name,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_new,
            "stream": False,
            **_VLLM_GEN_KWARGS,
        }

        try:
            log.info("[AI] Segment %d/%d: %d chars, max_tokens=%d, requesting...",
                     i + 1, total, len(text), max_new)

            resp = httpx.post(
                f"{vllm_url}/v1/chat/completions",
                json=payload,
                timeout=300,
            )
            resp.raise_for_status()
            data = resp.json()

            result = data["choices"][0]["message"]["content"].strip()
            usage = data.get("usage", {})
            in_tok = usage.get("prompt_tokens", "?")
            out_tok = usage.get("completion_tokens", "?")

            # 去掉模型可能输出的注释
            note_idx = result.find("（注")
            if note_idx != -1:
                result = result[:note_idx].strip()

            elapsed = time.time() - seg_start
            preview = result[:80].replace('\n', ' ') if result else '(empty)'
            log.info("[AI] Segment %d/%d: done in %.1fs, in=%s out=%s tokens, preview: %s",
                     i + 1, total, elapsed, in_tok, out_tok, preview)
            results.append(result if result else text)
        except Exception as e:
            elapsed = time.time() - seg_start
            log.error("[AI] Segment %d/%d: FAILED after %.1fs: %s", i + 1, total, elapsed, e)
            results.append(text)

    log.info("[AI] All %d segments translated", total)
    return results


# ---------------------------------------------------------------------------
# AI翻译：章节级别（将多段合并为一次请求，超长自动分块）
# ---------------------------------------------------------------------------

def translate_ai_chapter(
    texts: list[str],
    src_lang: str,
    tgt_lang: str,
    context: Optional[str] = None,
    glossary: Optional[dict] = None,
) -> list[str]:
    """章节级别 AI 翻译：将段落合并后整体翻译，超长时自动分块。

    返回与 texts 等长的翻译列表。
    """
    if not texts:
        return []

    # 过滤空段落，记录索引映射
    non_empty: list[tuple[int, str]] = []
    for i, t in enumerate(texts):
        if t and t.strip():
            non_empty.append((i, t))

    if not non_empty:
        return list(texts)

    # 按 _MAX_CHAPTER_INPUT_CHARS 分块
    chunks: list[list[tuple[int, str]]] = []
    current_chunk: list[tuple[int, str]] = []
    current_len = 0
    for idx, text in non_empty:
        text_len = len(text)
        if current_chunk and current_len + text_len > _MAX_CHAPTER_INPUT_CHARS:
            chunks.append(current_chunk)
            current_chunk = []
            current_len = 0
        current_chunk.append((idx, text))
        current_len += text_len
    if current_chunk:
        chunks.append(current_chunk)

    log.info("[AI-Chapter] %d paragraphs split into %d chunk(s)", len(non_empty), len(chunks))

    # 初始化结果（默认保持原文）
    results = list(texts)

    vllm_url = os.getenv("VLLM_API_URL", "http://localhost:8000").rstrip("/")
    model_name = os.getenv("VLLM_MODEL_NAME", "HY-MT1.5")
    min_output_tokens = int(os.getenv("VLLM_MIN_OUTPUT_TOKENS", "256"))
    max_output_tokens = int(os.getenv("VLLM_MAX_OUTPUT_TOKENS", "4096"))
    # 硬上限: 不能超过 max_model_len 的一半 (留空间给 input)
    max_output_tokens = min(max_output_tokens, _MAX_MODEL_LEN // 2)
    if max_output_tokens < min_output_tokens:
        max_output_tokens = min_output_tokens

    separator = "\n\n"

    for ci, chunk in enumerate(chunks):
        chunk_texts = [t for _, t in chunk]
        combined = separator.join(chunk_texts)
        total_chars = len(combined)

        seg_start = time.time()
        prompt = _build_chapter_prompt(combined, src_lang, tgt_lang, context, glossary, separator)
        max_new = min(max(total_chars * 4, min_output_tokens), max_output_tokens)

        payload = {
            "model": model_name,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_new,
            "stream": False,
            **_VLLM_GEN_KWARGS,
        }

        try:
            log.info("[AI-Chapter] Chunk %d/%d: %d paragraphs, %d chars, max_tokens=%d",
                     ci + 1, len(chunks), len(chunk_texts), total_chars, max_new)

            resp = httpx.post(
                f"{vllm_url}/v1/chat/completions",
                json=payload,
                timeout=300,
            )
            resp.raise_for_status()
            data = resp.json()

            raw_result = data["choices"][0]["message"]["content"].strip()
            usage = data.get("usage", {})
            in_tok = usage.get("prompt_tokens", "?")
            out_tok = usage.get("completion_tokens", "?")
            elapsed = time.time() - seg_start
            log.info("[AI-Chapter] Chunk %d/%d: done in %.1fs, in=%s out=%s tokens",
                     ci + 1, len(chunks), elapsed, in_tok, out_tok)

            # 拆分翻译结果回各段落
            translated_parts = raw_result.split(separator)

            # 对齐：如果拆分数量不匹配，尝试用单换行分割
            if len(translated_parts) != len(chunk_texts):
                translated_parts = raw_result.split("\n")
                translated_parts = [p.strip() for p in translated_parts if p.strip()]

            for j, (orig_idx, _) in enumerate(chunk):
                if j < len(translated_parts) and translated_parts[j].strip():
                    result = translated_parts[j].strip()
                    # 去掉模型可能输出的注释
                    note_idx = result.find("（注")
                    if note_idx != -1:
                        result = result[:note_idx].strip()
                    results[orig_idx] = result

        except Exception as e:
            elapsed = time.time() - seg_start
            log.error("[AI-Chapter] Chunk %d/%d FAILED after %.1fs: %s",
                      ci + 1, len(chunks), elapsed, e)
            # 保持原文

    log.info("[AI-Chapter] All %d paragraphs translated", len(non_empty))
    return results


def _build_chapter_prompt(
    combined_text: str,
    src_lang: str,
    tgt_lang: str,
    context: Optional[str] = None,
    glossary: Optional[dict] = None,
    separator: str = "\n\n",
) -> str:
    """构建章节级翻译 prompt，要求模型保持段落分隔 (遵循 README 模板)"""
    parts = []

    # 术语表
    if glossary:
        parts.append(_build_glossary_block(glossary))

    # 上下文 + 指令
    is_cn = _is_cn_involved(src_lang, tgt_lang)

    if context:
        parts.append(context)
        if is_cn:
            instruction = (
                f"参考上面的信息，把下面的文本翻译成{tgt_lang}，注意不需要翻译上文，也不要额外解释。"
                f"文本由多个段落组成，段落之间用空行分隔，请保持相同的段落分隔格式："
            )
        else:
            instruction = (
                f"Based on the context above, translate the following text into {tgt_lang}. "
                f"Do not translate the context. "
                f"The text consists of multiple paragraphs separated by blank lines. "
                f"Keep the same paragraph separation and output only the translation."
            )
    else:
        if is_cn:
            instruction = (
                f"将以下文本翻译为{tgt_lang}。"
                f"文本由多个段落组成，段落之间用空行分隔。"
                f"请保持相同的段落分隔格式，逐段翻译，只输出翻译结果，不要额外解释："
            )
        else:
            instruction = (
                f"Translate the following text into {tgt_lang}. "
                f"The text consists of multiple paragraphs separated by blank lines. "
                f"Keep the same paragraph separation, translate each paragraph, "
                f"and output only the translation without additional explanation."
            )

    parts.append(instruction)
    parts.append(combined_text)
    return "\n\n".join(parts)
