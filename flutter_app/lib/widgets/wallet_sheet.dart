import 'package:flutter/material.dart';
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
  bool _checkedInToday = false;
  bool _checkinBusy = false;
  int _checkinPoints = 5000;

  @override
  void initState() {
    super.initState();
    _loadCheckinStatus();
    _loadConfig();
  }

  Future<void> _loadConfig() async {
    try {
      final resp = await ApiService().getConfig();
      if (mounted) {
        setState(() {
          _checkinPoints = (resp['checkin_points'] as num?)?.toInt() ?? 5000;
        });
      }
    } catch (_) {}
  }

  Future<void> _loadCheckinStatus() async {
    try {
      final status = await ApiService().checkinStatus();
      if (mounted) {
        setState(() {
          _checkedInToday = status['checkedInToday'] == true;
        });
      }
    } catch (_) {}
  }

  Future<void> _doCheckin() async {
    if (_checkedInToday || _checkinBusy) return;
    setState(() => _checkinBusy = true);
    try {
      final result = await ApiService().checkin();
      final points = (result['points'] as num?)?.toInt() ?? 0;
      if (mounted) {
        setState(() {
          _checkedInToday = true;
        });
        widget.onBalanceChanged();
        if (points > 0) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(
              content: Text('签到成功！+${NumberFormat("#,###").format(points)} 积分'),
              behavior: SnackBarBehavior.floating,
            ),
          );
        }
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('签到失败: $e'), behavior: SnackBarBehavior.floating),
        );
      }
    } finally {
      if (mounted) setState(() => _checkinBusy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final fmt = NumberFormat('#,###');

    return DraggableScrollableSheet(
      initialChildSize: 0.38,
      minChildSize: 0.25,
      maxChildSize: 0.6,
      expand: false,
      builder: (context, scrollController) {
        return SingleChildScrollView(
          controller: scrollController,
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 32),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: 8),

              // 余额
              Center(
                child: Column(
                  children: [
                    const Text('\ud83e\ude99', style: TextStyle(fontSize: 36)),
                    const SizedBox(height: 4),
                    Text(fmt.format(widget.balance), style: TextStyle(
                      fontSize: 36, fontWeight: FontWeight.bold, color: cs.primary,
                    )),
                    Text('当前积分余额', style: TextStyle(fontSize: 14, color: cs.onSurfaceVariant)),
                  ],
                ),
              ),
              const SizedBox(height: 24),

              // 每日签到
              _sectionCard(cs, Row(
                children: [
                  Icon(
                    _checkedInToday ? Icons.check_circle_rounded : Icons.calendar_today_rounded,
                    color: _checkedInToday ? Colors.green : cs.primary,
                    size: 28,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('每日签到', style: TextStyle(
                          fontSize: 14, fontWeight: FontWeight.w600, color: cs.onSurface,
                        )),
                        const SizedBox(height: 2),
                        Text(
                          _checkedInToday
                              ? '今日已签到'
                              : '签到领 +${NumberFormat('#,###').format(_checkinPoints)} 积分',
                          style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  SizedBox(
                    height: 34,
                    child: FilledButton(
                      onPressed: _checkedInToday || _checkinBusy ? null : _doCheckin,
                      style: FilledButton.styleFrom(
                        padding: const EdgeInsets.symmetric(horizontal: 16),
                        minimumSize: const Size(0, 34),
                      ),
                      child: Text(
                        _checkinBusy ? '签到中…' : (_checkedInToday ? '已签到' : '立即签到'),
                        style: const TextStyle(fontSize: 13),
                      ),
                    ),
                  ),
                ],
              )),
              const SizedBox(height: 12),
            ],
          ),
        );
      },
    );
  }

  Widget _sectionCard(ColorScheme cs, Widget child) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: cs.surfaceContainerLowest,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: cs.outlineVariant.withValues(alpha: 0.5)),
      ),
      child: child,
    );
  }
}
