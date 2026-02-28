import 'dart:convert';
import 'dart:typed_data';
import 'package:archive/archive.dart';

/// EPUB 解析工具：字数统计 + 封面提取
class EpubCharCounter {

  /// 从 EPUB 中提取封面图片，返回 base64 data URI，失败返回 null
  static String? extractCoverBase64(Uint8List epubBytes) {
    try {
      final archive = ZipDecoder().decodeBytes(epubBytes);

      // 1. 找到 OPF 文件
      String? opfContent;
      String opfDir = '';
      for (final file in archive) {
        if (!file.isFile) continue;
        if (file.name.toLowerCase().endsWith('.opf')) {
          opfContent = utf8.decode(file.content as List<int>, allowMalformed: true);
          final parts = file.name.split('/');
          if (parts.length > 1) opfDir = '${parts.sublist(0, parts.length - 1).join('/')}/';
          break;
        }
      }

      // 2. 从 OPF 中找 cover image 的 href
      String? coverHref;
      if (opfContent != null) {
        // 方法 A: <meta name="cover" content="cover-image-id"/>  → 找对应 <item id="cover-image-id" href="..."/>
        final metaMatch = RegExp(r'<meta[^>]*name\s*=\s*"cover"[^>]*content\s*=\s*"([^"]+)"', caseSensitive: false).firstMatch(opfContent);
        if (metaMatch != null) {
          final coverId = metaMatch.group(1)!;
          final itemMatch = RegExp('id\\s*=\\s*"${RegExp.escape(coverId)}"[^>]*href\\s*=\\s*"([^"]+)"', caseSensitive: false).firstMatch(opfContent);
          if (itemMatch != null) coverHref = itemMatch.group(1);
        }
        // 方法 B: <item properties="cover-image" href="..."/>
        if (coverHref == null) {
          final propMatch = RegExp(r'properties\s*=\s*"cover-image"[^>]*href\s*=\s*"([^"]+)"', caseSensitive: false).firstMatch(opfContent);
          if (propMatch != null) coverHref = propMatch.group(1);
        }
      }

      // 3. 定位封面文件
      ArchiveFile? coverFile;
      if (coverHref != null) {
        final fullPath = opfDir + coverHref;
        coverFile = _findFile(archive, (f) => f.name == fullPath || f.name == coverHref);
      }
      // 4. Fallback: 找第一个名含 cover 的图片
      coverFile ??= _findFile(archive, (f) =>
          f.name.toLowerCase().contains('cover') && _isImageFile(f.name));
      // 5. Fallback: 找第一个图片
      coverFile ??= _findFile(archive, (f) => _isImageFile(f.name));

      if (coverFile == null) return null;

      final bytes = coverFile.content as List<int>;
      if (bytes.isEmpty || bytes.length > 30000) return null;

      final mime = _imageMime(coverFile.name);
      final b64 = base64Encode(Uint8List.fromList(bytes));
      return 'data:$mime;base64,$b64';
    } catch (_) {
      return null;
    }
  }

  static ArchiveFile? _findFile(Archive archive, bool Function(ArchiveFile) test) {
    for (final f in archive) {
      if (f.isFile && test(f)) return f;
    }
    return null;
  }

  static bool _isImageFile(String name) {
    final lower = name.toLowerCase();
    return lower.endsWith('.jpg') || lower.endsWith('.jpeg') ||
        lower.endsWith('.png') || lower.endsWith('.gif') ||
        lower.endsWith('.webp') || lower.endsWith('.svg');
  }

  static String _imageMime(String name) {
    final lower = name.toLowerCase();
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.svg')) return 'image/svg+xml';
    return 'image/jpeg';
  }

  /// 计算 EPUB 中的可翻译字符数
  static int countChars(Uint8List epubBytes) {
    try {
      final archive = ZipDecoder().decodeBytes(epubBytes);
      int totalChars = 0;

      for (final file in archive) {
        if (!file.isFile) continue;
        final name = file.name.toLowerCase();
        if (!name.endsWith('.html') &&
            !name.endsWith('.xhtml') &&
            !name.endsWith('.htm')) {
          continue;
        }

        // 跳过 toc/nav 文件
        final baseName = name.split('/').last;
        if (baseName.startsWith('toc') || baseName.startsWith('nav')) continue;

        try {
          final content = utf8.decode(file.content as List<int>, allowMalformed: true);
          totalChars += _extractTextLength(content);
        } catch (_) {}
      }

      return totalChars > 0 ? totalChars : _fallbackEstimate(epubBytes.length);
    } catch (_) {
      return _fallbackEstimate(epubBytes.length);
    }
  }

  /// 从 HTML 中提取纯文本长度（去除标签、脚本、样式）
  static int _extractTextLength(String html) {
    // 移除 script 和 style 标签内容
    var text = html.replaceAll(RegExp(r'<script[^>]*>[\s\S]*?</script>', caseSensitive: false), '');
    text = text.replaceAll(RegExp(r'<style[^>]*>[\s\S]*?</style>', caseSensitive: false), '');
    // 移除所有 HTML 标签
    text = text.replaceAll(RegExp(r'<[^>]+>'), '');
    // 解码常见 HTML 实体
    text = text
        .replaceAll('&nbsp;', ' ')
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&amp;', '&')
        .replaceAll('&quot;', '"')
        .replaceAll('&#39;', "'")
        .replaceAll(RegExp(r'&#\d+;'), ' ');
    // 去除多余空白
    text = text.replaceAll(RegExp(r'\s+'), ' ').trim();
    return text.length;
  }

  /// 无法解压时的粗略估算
  static int _fallbackEstimate(int fileSize) {
    // EPUB 压缩后大小 × 3(解压比) / 3(HTML标签占比) ≈ 实际文本
    return (fileSize * 3 / 3).round().clamp(100, 10000000);
  }
}
