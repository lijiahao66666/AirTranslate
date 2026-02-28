import 'package:flutter/material.dart';

class EngineSelector extends StatelessWidget {
  final String selected; // "MACHINE" or "AI"
  final ValueChanged<String> onChanged;

  const EngineSelector({
    super.key,
    required this.selected,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Row(
      children: [
        Expanded(child: _card(context, cs, 'MACHINE', Icons.translate_rounded, '机器翻译', '免费 · 速度快', '适合通读')),
        const SizedBox(width: 12),
        Expanded(child: _card(context, cs, 'AI', Icons.auto_awesome_rounded, 'AI翻译', '消耗积分 · 质量更高', '支持术语/上下文')),
      ],
    );
  }

  Widget _card(BuildContext context, ColorScheme cs, String value, IconData icon, String title, String sub1, String sub2) {
    final isSelected = selected == value;
    return GestureDetector(
      onTap: () => onChanged(value),
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
}
