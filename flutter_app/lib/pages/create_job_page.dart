import 'dart:typed_data';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../services/api_service.dart';
import '../services/epub_char_counter.dart';
import '../widgets/engine_selector.dart';

class CreateJobPage extends StatefulWidget {
  const CreateJobPage({super.key});

  @override
  State<CreateJobPage> createState() => _CreateJobPageState();
}

class _CreateJobPageState extends State<CreateJobPage> {
  final _api = ApiService();

  // 文件
  String? _fileName;
  Uint8List? _fileBytes;
  int _charCount = 0;

  // 选项
  String _engineType = 'MACHINE';
  String _sourceLang = 'auto';
  String _targetLang = 'en';
  String _output = 'BILINGUAL';
  bool _useContext = true;
  bool _useGlossary = false;

  // 术语表
  Uint8List? _glossaryBytes;
  String? _glossaryFileName;

  // 状态
  bool _submitting = false;
  bool _counting = false;

  // 计费配置（从服务端读取）
  int _billingUnitChars = 1000;
  int _billingUnitCost = 1;

  @override
  void initState() {
    super.initState();
    _loadBillingConfig();
  }

  Future<void> _loadBillingConfig() async {
    try {
      final cfg = await _api.getConfig();
      if (mounted) {
        setState(() {
          _billingUnitChars = (cfg['billing_unit_chars'] ?? 1000) as int;
          _billingUnitCost = (cfg['billing_unit_cost'] ?? 1) as int;
        });
      }
    } catch (_) {}
  }

  static const _languages = [
    ('auto', '自动检测'),
    ('zh', '简体中文'),
    ('zh-tw', '繁体中文'),
    ('en', '英语'),
    ('ja', '日语'),
    ('ko', '韩语'),
    ('fr', '法语'),
    ('de', '德语'),
    ('es', '西班牙语'),
    ('ru', '俄语'),
    ('pt', '葡萄牙语'),
    ('it', '意大利语'),
    ('ar', '阿拉伯语'),
    ('th', '泰语'),
    ('vi', '越南语'),
  ];

  // 目标语言不包含 auto
  List<(String, String)> get _targetLanguages => _languages.where((e) => e.$1 != 'auto').toList();

  int get _estimatedPoints {
    if (_engineType != 'AI' || _charCount <= 0) return 0;
    return (_charCount / _billingUnitChars).ceil() * _billingUnitCost;
  }

  Future<void> _pickFile() async {
    final result = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: ['epub'],
      withData: true,
    );
    if (result != null && result.files.isNotEmpty) {
      final file = result.files.first;
      setState(() {
        _fileName = file.name;
        _fileBytes = file.bytes;
        _charCount = 0;
        _counting = true;
      });
      // 精确计算：解压 EPUB 提取 HTML 纯文本字数 + 封面
      final bytes = file.bytes;
      if (bytes != null) {
        final count = EpubCharCounter.countChars(bytes);
        if (mounted) {
          setState(() {
            _charCount = count.clamp(100, 10000000);
            _counting = false;
          });
        }
      } else {
        if (mounted) setState(() => _counting = false);
      }
    }
  }

  Future<void> _pickGlossary() async {
    final result = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: ['json'],
      withData: true,
    );
    if (result != null && result.files.isNotEmpty) {
      setState(() {
        _glossaryFileName = result.files.first.name;
        _glossaryBytes = result.files.first.bytes;
      });
    }
  }

  Future<void> _submit() async {
    if (_fileBytes == null || _fileName == null) {
      _showError('请先选择书籍文件');
      return;
    }
    if (_targetLang.isEmpty) {
      _showError('请选择目标语言');
      return;
    }

    setState(() => _submitting = true);
    try {
      // 1. 创建任务
      final result = await _api.createJob(
        engineType: _engineType,
        output: _output,
        sourceLang: _sourceLang,
        targetLang: _targetLang,
        sourceFileName: _fileName!,
        charCount: _charCount,
        useContext: _engineType == 'AI' && _useContext,
        useGlossary: _engineType == 'AI' && _useGlossary && _glossaryBytes != null,
      );

      final uploadInfo = result['upload'] as Map<String, dynamic>;
      final uploadUrl = uploadInfo['url'] as String;

      // 2. 上传 EPUB
      await _api.uploadFile(uploadUrl, _fileBytes!, 'application/epub+zip');

      // 3. 上传术语表 (如有)
      if (_engineType == 'AI' && _useGlossary && _glossaryBytes != null && result['glossaryUpload'] != null) {
        final glossaryInfo = result['glossaryUpload'] as Map<String, dynamic>;
        await _api.uploadFile(glossaryInfo['url'] as String, _glossaryBytes!, 'application/json');
      }

      // 4. 标记上传完成，加入队列
      final jobId = result['jobId'] as String;
      await _api.markUploaded(jobId);

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('任务创建成功！'), behavior: SnackBarBehavior.floating),
        );
        Navigator.pop(context, true);
      }
    } on ApiException catch (e) {
      if (e.isPointsInsufficient) {
        _showError('积分不足！需要 ${NumberFormat("#,###").format(e.needPoints)} 积分，当前余额 ${NumberFormat("#,###").format(e.currentBalance)}');
      } else {
        _showError('创建失败: ${e.message}');
      }
    } catch (e) {
      _showError('网络错误: $e');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  void _showError(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), behavior: SnackBarBehavior.floating),
    );
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final fmt = NumberFormat('#,###');

    return Scaffold(
      appBar: AppBar(title: const Text('新建翻译任务')),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // ── 选择文件 ──
            GestureDetector(
              onTap: _pickFile,
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(vertical: 28),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: cs.outlineVariant, style: BorderStyle.solid),
                  color: cs.surfaceContainerLowest,
                ),
                child: Column(
                  children: [
                    Icon(Icons.attach_file, size: 32, color: cs.primary),
                    const SizedBox(height: 8),
                    Text(
                      _fileName ?? '点击选择书籍文件',
                      style: TextStyle(
                        fontSize: 15,
                        color: _fileName != null ? cs.onSurface : cs.onSurfaceVariant,
                        fontWeight: _fileName != null ? FontWeight.w500 : FontWeight.normal,
                      ),
                    ),
                    if (_fileName == null)
                      Text('支持 EPUB 格式', style: TextStyle(fontSize: 13, color: cs.outlineVariant)),
                    if (_fileName != null && _counting)
                      Text('正在计算字数...', style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant)),
                    if (_fileName != null && !_counting)
                      Text('约 ${fmt.format(_charCount)} 字', style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant)),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 24),

            // ── 翻译引擎 ──
            _sectionTitle('翻译引擎'),
            const SizedBox(height: 12),
            EngineSelector(
              selected: _engineType,
              onChanged: (v) => setState(() => _engineType = v),
            ),
            const SizedBox(height: 24),

            // ── 语言设置 ──
            _sectionTitle('语言设置'),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: _dropdown<String>(
                    label: '源语言',
                    value: _sourceLang,
                    items: _languages.map((e) => DropdownMenuItem(value: e.$1, child: Text(e.$2, style: const TextStyle(fontSize: 14)))).toList(),
                    onChanged: (v) => setState(() => _sourceLang = v ?? 'auto'),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  child: Icon(Icons.arrow_forward, color: cs.onSurfaceVariant, size: 20),
                ),
                Expanded(
                  child: _dropdown<String>(
                    label: '目标语言',
                    value: _targetLang,
                    items: _targetLanguages.map((e) => DropdownMenuItem(value: e.$1, child: Text(e.$2, style: const TextStyle(fontSize: 14)))).toList(),
                    onChanged: (v) => setState(() => _targetLang = v ?? 'zh'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 24),

            // ── 输出格式 ──
            _sectionTitle('输出格式'),
            const SizedBox(height: 8),
            Row(
              children: [
                _radioChip(cs, '纯译文', 'TRANSLATED_ONLY'),
                const SizedBox(width: 12),
                _radioChip(cs, '双语对照', 'BILINGUAL'),
              ],
            ),
            const SizedBox(height: 24),

            // ── AI 高级选项 (仅 AI 显示) ──
            if (_engineType == 'AI') ...[
              _sectionTitle('AI翻译高级选项'),
              const SizedBox(height: 8),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('启用上下文翻译', style: TextStyle(fontSize: 15)),
                subtitle: Text('自动将前文作为上下文，提升连贯性', style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant)),
                value: _useContext,
                onChanged: (v) => setState(() => _useContext = v),
              ),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('使用术语表', style: TextStyle(fontSize: 15)),
                subtitle: Text('上传 JSON 格式术语表 {"原文": "译文", ...}', style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant)),
                value: _useGlossary,
                onChanged: (v) => setState(() => _useGlossary = v),
              ),
              if (_useGlossary)
                Padding(
                  padding: const EdgeInsets.only(left: 16, bottom: 8),
                  child: OutlinedButton.icon(
                    onPressed: _pickGlossary,
                    icon: const Icon(Icons.attach_file, size: 18),
                    label: Text(_glossaryFileName ?? '选择术语表 JSON'),
                    style: OutlinedButton.styleFrom(minimumSize: const Size(0, 40)),
                  ),
                ),
              const SizedBox(height: 12),

              // 费用预估
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(12),
                  color: cs.primaryContainer.withValues(alpha: 0.3),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('费用预估', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: cs.onSurface)),
                    const SizedBox(height: 8),
                    Text('\ud83d\udcca ${fmt.format(_charCount)} \u5b57 \u00d7 $_billingUnitCost\u79ef\u5206/${fmt.format(_billingUnitChars)}\u5b57', style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant)),
                    Text('💰 预计消耗: ${fmt.format(_estimatedPoints)} 积分', style: TextStyle(fontSize: 13, color: cs.primary, fontWeight: FontWeight.w500)),
                  ],
                ),
              ),
              const SizedBox(height: 24),
            ],

            // ── 提交按钮 ──
            FilledButton(
              onPressed: _submitting ? null : _submit,
              child: _submitting
                  ? const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                  : const Text('开始翻译'),
            ),
            const SizedBox(height: 32),
          ],
        ),
      ),
    );
  }

  Widget _sectionTitle(String title) {
    return Text(title, style: TextStyle(
      fontSize: 15, fontWeight: FontWeight.w600,
      color: Theme.of(context).colorScheme.onSurface,
    ));
  }

  Widget _dropdown<T>({
    required String label,
    required T value,
    required List<DropdownMenuItem<T>> items,
    required ValueChanged<T?> onChanged,
  }) {
    return DropdownButtonFormField<T>(
      initialValue: value,
      items: items,
      onChanged: onChanged,
      decoration: InputDecoration(
        labelText: label,
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      ),
    );
  }

  Widget _radioChip(ColorScheme cs, String label, String value) {
    final selected = _output == value;
    return ChoiceChip(
      label: Text(label),
      selected: selected,
      onSelected: (_) => setState(() => _output = value),
      selectedColor: cs.primaryContainer,
      labelStyle: TextStyle(
        color: selected ? cs.primary : cs.onSurfaceVariant,
        fontWeight: selected ? FontWeight.w600 : FontWeight.normal,
      ),
    );
  }
}
