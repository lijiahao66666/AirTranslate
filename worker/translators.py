"""
翻译引擎模块
- 机器翻译：Azure Edge → MyMemory → Google (链式退避，国内优先)
- AI翻译：本地 transformers HY-MT1.5 (支持上下文 + 术语表)
"""

import logging
import os
import time
import urllib.parse
from typing import Optional

import httpx
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

log = logging.getLogger(__name__)

MODEL_PATH = os.getenv("MODEL_PATH", "")
MYMEMORY_EMAIL = os.getenv("MYMEMORY_EMAIL", "")

# 懒加载模型 (首次调用 AI 翻译时才加载)
_model_cache: dict = {"model": None, "tokenizer": None, "loaded": False}

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
# AI翻译：本地 transformers HY-MT1.5
# ---------------------------------------------------------------------------

# HY-MT1.5 官方推荐推理参数
_HY_GEN_KWARGS = {
    "top_k": 20,
    "top_p": 0.6,
    "temperature": 0.7,
    "repetition_penalty": 1.05,
}


def _ensure_model_loaded():
    """懒加载模型和 tokenizer，首次调用时加载到 GPU"""
    if _model_cache["loaded"]:
        return _model_cache["model"], _model_cache["tokenizer"]

    model_path = MODEL_PATH
    if not model_path:
        raise TranslateError("MODEL_PATH not set in .env")

    log.info("Loading HY-MT1.5 model from %s ...", model_path)
    tokenizer = AutoTokenizer.from_pretrained(model_path)
    model = AutoModelForCausalLM.from_pretrained(
        model_path,
        device_map="auto",
        torch_dtype=torch.bfloat16,
    )
    model.eval()
    log.info("Model loaded successfully on %s", next(model.parameters()).device)

    _model_cache["model"] = model
    _model_cache["tokenizer"] = tokenizer
    _model_cache["loaded"] = True
    return model, tokenizer


def _build_ai_prompt(
    text: str,
    src_lang: str,
    tgt_lang: str,
    context: Optional[str] = None,
    glossary: Optional[dict] = None,
) -> str:
    """构建 HY-MT1.5 翻译 prompt"""
    parts = []

    # 术语表
    if glossary:
        glossary_lines = "\n".join(
            f"{k} 翻译成 {v}" for k, v in glossary.items()
        )
        parts.append(f"参考下面的翻译：\n{glossary_lines}")

    # 上下文
    if context:
        parts.append(context)
        parts.append(f"参考上面的信息，把下面的文本翻译成{tgt_lang}，注意只需要输出翻译后的结果，不要额外解释：")
    else:
        # 判断是否为中外互译
        cn_langs = {"zh", "zh-cn", "zh-tw", "zh-hans", "zh-hant"}
        is_cn_involved = src_lang.lower() in cn_langs or tgt_lang.lower() in cn_langs
        if is_cn_involved:
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
    """AI翻译：本地 transformers HY-MT1.5
    逐段翻译，每段独立推理 (段落翻译模式)
    """
    model, tokenizer = _ensure_model_loaded()
    results = []

    for text in texts:
        if not text or not text.strip():
            results.append(text)
            continue

        prompt = _build_ai_prompt(text, src_lang, tgt_lang, context, glossary)
        messages = [{"role": "user", "content": prompt}]

        try:
            input_ids = tokenizer.apply_chat_template(
                messages,
                tokenize=True,
                add_generation_prompt=False,
                return_tensors="pt",
            ).to(model.device)

            max_new = max(len(text) * 3, 512)
            with torch.no_grad():
                output_ids = model.generate(
                    input_ids,
                    max_new_tokens=max_new,
                    do_sample=True,
                    **_HY_GEN_KWARGS,
                )

            # 只取新生成的 token
            new_tokens = output_ids[0][input_ids.shape[-1]:]
            result = tokenizer.decode(new_tokens, skip_special_tokens=True).strip()

            # 去掉模型可能输出的注释 "（注..."
            note_idx = result.find("（注")
            if note_idx != -1:
                result = result[:note_idx].strip()
            results.append(result if result else text)
        except Exception as e:
            log.error("AI translate error for text[:%d]: %s", min(50, len(text)), e)
            results.append(text)  # 失败时保留原文

    return results
