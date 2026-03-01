import 'package:flutter/material.dart';

class EngineSelector extends StatelessWidget {
  final String selected; // "MACHINE" or "AI" or "AI_ONLINE"
  final bool localAiAvailable;
  final ValueChanged<String> onChanged;

  const EngineSelector({
    super.key,
    required this.selected,
    required this.localAiAvailable,
    required this.onChanged,
  });

  bool get _isAI => selected == 'AI' || selected == 'AI_ONLINE';

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(child: _card(cs, false, Icons.translate_rounded, '机器翻译', '免费 · 速度快', '适合通读')),
            const SizedBox(width: 12),
            Expanded(child: _card(cs, true, Icons.auto_awesome_rounded, 'AI翻译', '消耗积分 · 质量更高', '支持术语/上下文')),
          ],
        ),
        if (_isAI) ...[
          const SizedBox(height: 14),
          _aiSubSelector(cs),
        ],
      ],
    );
  }

  Widget _card(ColorScheme cs, bool isAI, IconData icon, String title, String sub1, String sub2) {
    final isSelected = isAI ? _isAI : selected == 'MACHINE';
    return GestureDetector(
      onTap: () {
        if (isAI) {
          if (!_isAI) {
            onChanged(localAiAvailable ? 'AI' : 'AI_ONLINE');
          }
        } else {
          onChanged('MACHINE');
        }
      },
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: isSelected ? cs.primary : cs.outlineVariant,
            width: isSelected ? 2 : 1,
          ),
          color: isSelected ? cs.primaryContainer.withValues(alpha: 0.3) : cs.surfaceContainerLowest,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, size: 28, color: isSelected ? cs.primary : cs.onSurfaceVariant),
            const SizedBox(height: 8),
            Text(title, style: TextStyle(
              fontSize: 16, fontWeight: FontWeight.w600,
              color: isSelected ? cs.primary : cs.onSurface,
            )),
            const SizedBox(height: 4),
            Text(sub1, style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant)),
            Text(sub2, style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant)),
          ],
        ),
      ),
    );
  }

  Widget _aiSubSelector(ColorScheme cs) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(12),
        color: cs.surfaceContainerLow,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('AI 翻译模式', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: cs.onSurface)),
          const SizedBox(height: 10),
          _aiOption(
            cs,
            value: 'AI_ONLINE',
            icon: Icons.cloud_rounded,
            title: '在线翻译',
            desc: '混元翻译API · 质量高 · 速度快 · 积分消耗较多',
          ),
          if (localAiAvailable) ...[
            const SizedBox(height: 8),
            _aiOption(
              cs,
              value: 'AI',
              icon: Icons.memory_rounded,
              title: '个人部署',
              desc: '本地 HY-MT1.5-7B · 速度较慢 · 积分消耗少',
            ),
          ],
        ],
      ),
    );
  }

  Widget _aiOption(ColorScheme cs, {required String value, required IconData icon, required String title, required String desc}) {
    final isSel = selected == value;
    return GestureDetector(
      onTap: () => onChanged(value),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: isSel ? cs.primary : cs.outlineVariant, width: isSel ? 1.5 : 1),
          color: isSel ? cs.primaryContainer.withValues(alpha: 0.25) : cs.surface,
        ),
        child: Row(
          children: [
            Icon(icon, size: 20, color: isSel ? cs.primary : cs.onSurfaceVariant),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: isSel ? cs.primary : cs.onSurface)),
                  Text(desc, style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant)),
                ],
              ),
            ),
            if (isSel) Icon(Icons.check_circle, size: 20, color: cs.primary),
          ],
        ),
      ),
    );
  }
}
