import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:intl/intl.dart';
import '../services/api_service.dart';

class WalletSheet extends StatefulWidget {
  final int balance;
  final VoidCallback onBalanceChanged;

  const WalletSheet({
    super.key,
    required this.balance,
    required this.onBalanceChanged,
  });

  static Future<void> show(BuildContext context, int balance, VoidCallback onBalanceChanged) {
    return showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (_) => WalletSheet(balance: balance, onBalanceChanged: onBalanceChanged),
    );
  }

  @override
  State<WalletSheet> createState() => _WalletSheetState();
}

class _WalletSheetState extends State<WalletSheet> {
  final _codeController = TextEditingController();
  bool _redeeming = false;
  String? _redeemMessage;
  bool _redeemSuccess = false;

  // TODO: 替换为你的实际 SKU 和购买链接
  static const _skus = [
    _Sku('5万积分', 50000, '¥--', ''),
    _Sku('10万积分', 100000, '¥--', ''),
    _Sku('20万积分', 200000, '¥--', ''),
    _Sku('50万积分', 500000, '¥--', ''),
    _Sku('100万积分', 1000000, '¥--', ''),
  ];

  @override
  void dispose() {
    _codeController.dispose();
    super.dispose();
  }

  Future<void> _redeem() async {
    final code = _codeController.text.trim();
    if (code.isEmpty) return;

    setState(() { _redeeming = true; _redeemMessage = null; });
    try {
      final result = await ApiService().redeem(code);
      final added = result['pointsAdded'] ?? 0;
      final fmt = NumberFormat('#,###');
      setState(() {
        _redeemSuccess = true;
        _redeemMessage = '兑换成功！获得 ${fmt.format(added)} 积分';
      });
      _codeController.clear();
      widget.onBalanceChanged();
    } on ApiException catch (e) {
      setState(() {
        _redeemSuccess = false;
        if (e.data?['alreadyUsed'] == true) {
          _redeemMessage = '该卡密已被使用';
        } else {
          _redeemMessage = '兑换失败: ${e.message}';
        }
      });
    } catch (e) {
      setState(() { _redeemSuccess = false; _redeemMessage = '网络错误: $e'; });
    } finally {
      setState(() => _redeeming = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final fmt = NumberFormat('#,###');

    return DraggableScrollableSheet(
      initialChildSize: 0.7,
      minChildSize: 0.4,
      maxChildSize: 0.9,
      expand: false,
      builder: (context, scrollController) {
        return SingleChildScrollView(
          controller: scrollController,
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 32),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // 拖拽条
              Center(
                child: Container(
                  width: 40, height: 4,
                  decoration: BoxDecoration(
                    color: cs.outlineVariant,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              const SizedBox(height: 20),

              // 余额
              Center(
                child: Column(
                  children: [
                    Text('🪙', style: const TextStyle(fontSize: 36)),
                    const SizedBox(height: 4),
                    Text(fmt.format(widget.balance), style: TextStyle(
                      fontSize: 36, fontWeight: FontWeight.bold, color: cs.primary,
                    )),
                    Text('当前积分余额', style: TextStyle(fontSize: 14, color: cs.onSurfaceVariant)),
                  ],
                ),
              ),
              const SizedBox(height: 28),

              // 购买积分
              Text('购买积分', style: TextStyle(
                fontSize: 16, fontWeight: FontWeight.w600, color: cs.onSurface,
              )),
              const SizedBox(height: 12),
              Wrap(
                spacing: 10,
                runSpacing: 10,
                children: _skus.map((sku) => _skuChip(context, cs, sku)).toList(),
              ),
              const SizedBox(height: 28),

              // 兑换卡密
              Text('兑换卡密', style: TextStyle(
                fontSize: 16, fontWeight: FontWeight.w600, color: cs.onSurface,
              )),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _codeController,
                      decoration: const InputDecoration(hintText: '请输入卡密...'),
                      onSubmitted: (_) => _redeem(),
                    ),
                  ),
                  const SizedBox(width: 10),
                  FilledButton(
                    onPressed: _redeeming ? null : _redeem,
                    style: FilledButton.styleFrom(minimumSize: const Size(72, 52)),
                    child: _redeeming
                        ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                        : const Text('兑换'),
                  ),
                ],
              ),
              if (_redeemMessage != null) ...[
                const SizedBox(height: 8),
                Text(_redeemMessage!, style: TextStyle(
                  fontSize: 13,
                  color: _redeemSuccess ? Colors.green : cs.error,
                )),
              ],
              const SizedBox(height: 28),

              // 使用说明
              Text('使用说明', style: TextStyle(
                fontSize: 16, fontWeight: FontWeight.w600, color: cs.onSurface,
              )),
              const SizedBox(height: 8),
              _infoRow(cs, 'AI翻译按字数消耗积分'),
              _infoRow(cs, '机器翻译完全免费'),
              _infoRow(cs, '1积分 ≈ 1000字翻译'),
              _infoRow(cs, '翻译失败自动退还积分'),
            ],
          ),
        );
      },
    );
  }

  Widget _skuChip(BuildContext context, ColorScheme cs, _Sku sku) {
    return SizedBox(
      width: 100,
      child: OutlinedButton(
        onPressed: sku.url.isEmpty ? null : () => launchUrl(Uri.parse(sku.url)),
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(100, 64),
          padding: const EdgeInsets.symmetric(vertical: 8),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(sku.label, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: cs.onSurface)),
            const SizedBox(height: 2),
            Text(sku.price, style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant)),
          ],
        ),
      ),
    );
  }

  Widget _infoRow(ColorScheme cs, String text) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        children: [
          Icon(Icons.circle, size: 6, color: cs.onSurfaceVariant),
          const SizedBox(width: 8),
          Text(text, style: TextStyle(fontSize: 13, color: cs.onSurfaceVariant)),
        ],
      ),
    );
  }
}

class _Sku {
  final String label;
  final int points;
  final String price;
  final String url;
  const _Sku(this.label, this.points, this.price, this.url);
}
