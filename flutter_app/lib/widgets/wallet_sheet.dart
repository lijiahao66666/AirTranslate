import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../services/api_service.dart';
import '../services/auth_service.dart';
import '../pages/login_page.dart';

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
  int _initialGrantPoints = 500000;
  int _currentBalance = 0;

  @override
  void initState() {
    super.initState();
    _currentBalance = widget.balance;
    _loadCheckinStatus();
    _loadConfig();
  }

  Future<void> _loadConfig() async {
    try {
      final resp = await ApiService().getConfig();
      if (mounted) {
        setState(() {
          _checkinPoints = (resp['checkin_points'] as num?)?.toInt() ?? 5000;
          _initialGrantPoints = (resp['initial_grant_points'] as num?)?.toInt() ?? 500000;
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

  Future<void> _refreshBalance() async {
    try {
      final balance = await ApiService().getBalance();
      if (mounted) setState(() => _currentBalance = balance);
    } catch (_) {}
  }

  Future<void> _doCheckin() async {
    if (_checkedInToday || _checkinBusy) return;
    setState(() => _checkinBusy = true);
    try {
      final result = await ApiService().checkin();
      final points = (result['points'] as num?)?.toInt() ?? 0;
      final newBalance = (result['balance'] as num?)?.toInt();
      if (mounted) {
        setState(() {
          _checkedInToday = true;
          if (newBalance != null) {
            _currentBalance = newBalance;
          } else {
            _currentBalance += points;
          }
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

    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // 标题行
          Row(
            children: [
              Text(
                '积分钱包',
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w700,
                  color: cs.onSurface,
                ),
              ),
              const Spacer(),
              Text(
                '余额：${fmt.format(_currentBalance)}',
                style: TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                  color: cs.onSurface.withValues(alpha: 0.7),
                ),
              ),
            ],
          ),
          const SizedBox(height: 18),

          // 账户区块
          _sectionCard(
            cs,
            Row(
              children: [
                Icon(
                  AuthService.isLoggedIn
                      ? Icons.account_circle_rounded
                      : Icons.account_circle_outlined,
                  color: AuthService.isLoggedIn
                      ? Colors.green
                      : cs.onSurface.withValues(alpha: 0.5),
                  size: 28,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        AuthService.isLoggedIn
                            ? AuthService.phone
                            : '未登录',
                        style: TextStyle(
                          color: cs.onSurface,
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        AuthService.isLoggedIn
                            ? '积分跨设备同步'
                            : '登录赠送积分，并跨设备同步',
                        style: TextStyle(
                          color: cs.onSurface.withValues(alpha: 0.55),
                          fontSize: 12,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                SizedBox(
                  height: 32,
                  child: TextButton(
                    onPressed: () async {
                      if (AuthService.isLoggedIn) {
                        final confirm = await showDialog<bool>(
                          context: context,
                          builder: (ctx) => AlertDialog(
                            title: const Text('退出登录'),
                            content: const Text('退出后积分将归零，账户积分不会丢失，重新登录即可恢复'),
                            actions: [
                              TextButton(
                                onPressed: () => Navigator.pop(ctx, false),
                                child: const Text('取消'),
                              ),
                              TextButton(
                                onPressed: () => Navigator.pop(ctx, true),
                                child: const Text('确认退出'),
                              ),
                            ],
                          ),
                        );
                        if (confirm == true) {
                          await AuthService.logout();
                          widget.onBalanceChanged();
                          if (mounted) {
                            await _refreshBalance();
                            setState(() {});
                          }
                        }
                      } else {
                        if (!mounted) return;
                        final success = await LoginPage.show(
                          context,
                          initialGrantPoints: _initialGrantPoints,
                        );
                        if (success) {
                          widget.onBalanceChanged();
                          if (mounted) {
                            await _refreshBalance();
                            setState(() {});
                          }
                        }
                      }
                    },
                    style: TextButton.styleFrom(
                      backgroundColor: AuthService.isLoggedIn
                          ? cs.onSurface.withValues(alpha: 0.1)
                          : cs.primary,
                      foregroundColor: AuthService.isLoggedIn
                          ? cs.onSurface.withValues(alpha: 0.6)
                          : cs.onPrimary,
                      padding: const EdgeInsets.symmetric(horizontal: 14),
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(8),
                      ),
                    ),
                    child: Text(
                      AuthService.isLoggedIn ? '退出' : '登录',
                      style: const TextStyle(
                          fontSize: 13, fontWeight: FontWeight.w600),
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),

          // 每日签到
          _sectionCard(
            cs,
            Row(
              children: [
                Icon(
                  _checkedInToday
                      ? Icons.check_circle_rounded
                      : Icons.calendar_today_rounded,
                  color: _checkedInToday ? Colors.green : cs.primary,
                  size: 28,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '每日签到',
                        style: TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                          color: cs.onSurface,
                        ),
                      ),
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
                      _checkinBusy
                          ? '签到中…'
                          : (_checkedInToday ? '已签到' : '立即签到'),
                      style: const TextStyle(fontSize: 13),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
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
