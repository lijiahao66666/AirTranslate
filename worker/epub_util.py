"""
EPUB 处理模块
- 解压/重打包 EPUB (mimetype STORED 合规)
- HTML 解析：提取可翻译文本节点
- 回写：纯译文 / 双语对照
"""

import logging
import os
import re
import zipfile
import zlib
from pathlib import Path
from typing import Callable, Optional

from bs4 import BeautifulSoup, NavigableString, Tag

log = logging.getLogger(__name__)

SKIP_TAGS = {"script", "style", "code", "pre"}

TRANSLATION_CSS = """
<style type="text/css">
  .translation-container { display: block; }
  .original-text { display: block; }
  .translated-text {
    display: block;
    margin-top: 4px;
    color: #666;
    font-size: 1.0em;
  }
</style>
"""


# ---------------------------------------------------------------------------
# EPUB 解压 / 打包
# ---------------------------------------------------------------------------

def unzip_epub(epub_path: str, dest_dir: str) -> None:
    """解压 EPUB 到 dest_dir"""
    dest = Path(dest_dir)
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(epub_path, "r") as zf:
        for entry in zf.infolist():
            target = (dest / entry.filename).resolve()
            # 安全检查：防止 zip slip
            if not str(target).startswith(str(dest.resolve())):
                raise IOError(f"Invalid zip entry: {entry.filename}")
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(entry) as src, open(target, "wb") as dst:
                    dst.write(src.read())


def zip_epub(source_dir: str, output_path: str) -> None:
    """重打包 EPUB，mimetype 文件 STORED（EPUB 规范要求）"""
    base = Path(source_dir).resolve()
    mimetype_path = base / "mimetype"

    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zf:
        # mimetype 必须是第一个文件，且 STORED 不压缩
        if mimetype_path.is_file():
            data = mimetype_path.read_bytes()
            info = zipfile.ZipInfo("mimetype")
            info.compress_type = zipfile.ZIP_STORED
            zf.writestr(info, data)

        # 其余文件按路径排序写入
        all_files = sorted(
            (p for p in base.rglob("*") if p.is_file() and p != mimetype_path),
            key=lambda p: str(p.relative_to(base)),
        )
        for file_path in all_files:
            arcname = str(file_path.relative_to(base)).replace("\\", "/")
            zf.write(file_path, arcname)


# ---------------------------------------------------------------------------
# HTML 文件发现
# ---------------------------------------------------------------------------

def find_html_files(root_dir: str) -> list[str]:
    """查找所有 .html / .xhtml 文件，按路径排序"""
    root = Path(root_dir)
    files = []
    for ext in ("*.html", "*.xhtml"):
        files.extend(root.rglob(ext))
    files.sort(key=lambda p: str(p))
    return [str(f) for f in files]


# ---------------------------------------------------------------------------
# HTML 文本提取 & 回写
# ---------------------------------------------------------------------------

def _is_translatable(text: str) -> bool:
    """判断文本是否需要翻译（至少包含一个字母字符）"""
    if not text or not text.strip():
        return False
    return any(c.isalpha() for c in text)


def _should_skip(tag: Tag) -> bool:
    """是否跳过该标签"""
    if tag.name and tag.name.lower() in SKIP_TAGS:
        return True
    # 跳过已处理的翻译容器
    if tag.get("class") and "translation-container" in tag.get("class", []):
        return True
    return False


def _in_translation_container(node) -> bool:
    """检查节点是否在翻译容器内"""
    parent = node.parent
    while parent:
        if isinstance(parent, Tag):
            classes = parent.get("class", [])
            if "translation-container" in classes:
                return True
        parent = parent.parent
    return False


def _collect_text_nodes(element: Tag) -> list[NavigableString]:
    """递归收集可翻译的文本节点"""
    nodes = []
    if _should_skip(element):
        return nodes

    for child in element.children:
        if isinstance(child, Tag):
            nodes.extend(_collect_text_nodes(child))
        elif isinstance(child, NavigableString):
            # 跳过 Comment 等特殊类型
            if type(child).__name__ in ("Comment", "ProcessingInstruction", "CData"):
                continue
            if _in_translation_container(child):
                continue
            if _is_translatable(child.string or ""):
                nodes.append(child)
    return nodes


def extract_texts(html_path: str) -> list[str]:
    """从 HTML 文件提取所有可翻译文本"""
    content = Path(html_path).read_text(encoding="utf-8")
    soup = _parse_html(content)
    body = soup.find("body")
    if not body:
        return []
    nodes = _collect_text_nodes(body)
    return [node.string for node in nodes]


def write_back(
    html_path: str,
    original_texts: list[str],
    translated_texts: list[str],
    output_mode: str = "BILINGUAL",
) -> None:
    """将翻译结果回写到 HTML 文件
    output_mode: "BILINGUAL" 双语对照 / "TRANSLATED_ONLY" 纯译文
    """
    content = Path(html_path).read_text(encoding="utf-8")

    # 保留 XML 声明和 DOCTYPE
    xml_decl = ""
    if content.startswith("<?xml"):
        end = content.index("?>") + 2
        xml_decl = content[:end]

    doctype = ""
    dt_start = content.find("<!DOCTYPE")
    if dt_start != -1:
        dt_end = content.index(">", dt_start) + 1
        doctype = content[dt_start:dt_end]

    soup = _parse_html(content)

    # 双语模式注入 CSS
    is_bilingual = output_mode.upper() != "TRANSLATED_ONLY"
    if is_bilingual:
        head = soup.find("head")
        if head and not head.find("style", string=re.compile("translation-container")):
            style_tag = BeautifulSoup(TRANSLATION_CSS, "html.parser")
            head.append(style_tag)

    body = soup.find("body")
    if not body:
        return

    nodes = _collect_text_nodes(body)

    # 安全检查：节点数 == 翻译数
    if len(nodes) != len(original_texts) or len(nodes) != len(translated_texts):
        log.warning(
            "Node count mismatch: nodes=%d, originals=%d, translations=%d in %s",
            len(nodes), len(original_texts), len(translated_texts), html_path,
        )
        # 尽可能匹配
        count = min(len(nodes), len(translated_texts))
    else:
        count = len(nodes)

    for i in range(count):
        node = nodes[i]
        translated = translated_texts[i]
        if not translated:
            continue

        if not is_bilingual:
            # 纯译文：直接替换文本
            node.replace_with(NavigableString(translated))
        else:
            # 双语对照：包裹在容器中
            original = node.string or ""
            container = soup.new_tag("div", **{"class": "translation-container"})
            orig_span = soup.new_tag("span", **{
                "class": "original-text",
                "data-translation": "original",
            })
            orig_span.string = original.strip()
            trans_div = soup.new_tag("div", **{
                "class": "translated-text",
                "data-translation": "translated",
            })
            trans_div.string = translated
            container.append(orig_span)
            container.append(trans_div)
            node.replace_with(container)

    # 输出
    result = str(soup)

    # 恢复 XML 声明和 DOCTYPE
    if xml_decl or doctype:
        prefix = ""
        if xml_decl:
            prefix += xml_decl + "\n"
        if doctype:
            prefix += doctype + "\n"
        # 移除 soup 可能生成的重复声明
        result = result.replace(xml_decl, "").replace(doctype, "")
        result = prefix + result

    Path(html_path).write_text(result, encoding="utf-8")


def count_translatable_chars(root_dir: str) -> int:
    """统计所有 HTML 文件中可翻译字符总数"""
    total = 0
    for html_path in find_html_files(root_dir):
        texts = extract_texts(html_path)
        for text in texts:
            if text:
                total += len(text)
    return total


# ---------------------------------------------------------------------------
# 内部辅助
# ---------------------------------------------------------------------------

def _parse_html(content: str) -> BeautifulSoup:
    """根据内容自动选择解析模式"""
    is_xhtml = (
        content.startswith("<?xml")
        or "xmlns=" in content[:500]
        or "<!DOCTYPE" in content[:200]
    )
    # 统一用 lxml 解析
    if is_xhtml:
        return BeautifulSoup(content, "lxml-xml")
    else:
        return BeautifulSoup(content, "lxml")
