import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';

import '../services/auth_service.dart';

/// 手机号验证码登录页面
class LoginPage extends StatefulWidget {
  const LoginPage({super.key});

  /// 显示登录页面（底部弹出），返回是否登录成功
  static Future<bool> show(BuildContext context) async {
    final result = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => const LoginPage(),
    );
    return result == true;
  }

  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final _phoneController = TextEditingController();
  final _codeController = TextEditingController();
  bool _sending = false;
  bool _logging = false;
  int _countdown = 0;
  Timer? _timer;
  String? _error;

  @override
  void dispose() {
    _phoneController.dispose();
    _codeController.dispose();
    _timer?.cancel();
    super.dispose();
  }

  bool get _phoneValid =>
      _phoneController.text.replaceAll(RegExp(r'[^0-9]'), '').length == 11;

  bool get _codeValid => _codeController.text.trim().length == 6;

  Future<void> _sendCode() async {
    if (!_phoneValid || _sending || _countdown > 0) return;
    setState(() {
      _sending = true;
      _error = null;
    });

    final result = await AuthService.sendSmsCode(_phoneController.text.trim());

    if (!mounted) return;
    setState(() => _sending = false);

    if (result.success) {
      setState(() => _countdown = 60);
      _timer?.cancel();
      _timer = Timer.periodic(const Duration(seconds: 1), (t) {
        if (!mounted) {
          t.cancel();
          return;
        }
        setState(() {
          _countdown--;
          if (_countdown <= 0) t.cancel();
        });
      });
    } else {
      setState(() => _error = result.error ?? '发送失败');
    }
  }

  Future<void> _login() async {
    if (!_phoneValid || !_codeValid || _logging) return;
    setState(() {
      _logging = true;
      _error = null;
    });

    final result = await AuthService.loginWithSmsCode(
      _phoneController.text.trim(),
      _codeController.text.trim(),
    );

    if (!mounted) return;
    setState(() => _logging = false);

    if (result.success) {
      if (result.isNewUser && result.balance != null && result.balance! > 0 && mounted) {
        await _showGrantAnimation(context, result.balance!);
      }
      if (mounted) Navigator.of(context).pop(true);
    } else {
      setState(() => _error = result.error ?? '登录失败');
    }
  }

  Future<void> _showGrantAnimation(BuildContext ctx, int points) async {
    final fmt = NumberFormat('#,###');
    await showGeneralDialog(
      context: ctx,
      barrierDismissible: true,
      barrierLabel: 'grant',
      barrierColor: Colors.black54,
      transitionDuration: const Duration(milliseconds: 350),
      transitionBuilder: (context, anim, _, child) {
        return ScaleTransition(
          scale: CurvedAnimation(parent: anim, curve: Curves.easeOutBack),
          child: FadeTransition(opacity: anim, child: child),
        );
      },
      pageBuilder: (context, _, __) {
        return Center(
          child: Material(
            color: Colors.transparent,
            child: Container(
              width: 260,
              padding: const EdgeInsets.symmetric(vertical: 28, horizontal: 24),
              decoration: BoxDecoration(
                color: Theme.of(context).brightness == Brightness.dark
                    ? const Color(0xFF2C2C2E)
                    : Colors.white,
                borderRadius: BorderRadius.circular(20),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text('🎉', style: TextStyle(fontSize: 40)),
                  const SizedBox(height: 12),
                  Text(
                    '登录成功',
                    style: TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                      color: Theme.of(context).brightness == Brightness.dark
                          ? Colors.white
                          : Colors.black87,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    '赠送初始积分',
                    style: TextStyle(
                      fontSize: 13,
                      color: Theme.of(context).brightness == Brightness.dark
                          ? Colors.white54
                          : Colors.black45,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    '+${fmt.format(points)}',
                    style: const TextStyle(
                      fontSize: 28,
                      fontWeight: FontWeight.bold,
                      color: Color(0xFF4FC3F7),
                    ),
                  ),
                  const SizedBox(height: 16),
                  SizedBox(
                    width: double.infinity,
                    height: 38,
                    child: FilledButton(
                      onPressed: () => Navigator.of(context).pop(),
                      style: FilledButton.styleFrom(
                        backgroundColor: const Color(0xFF4FC3F7),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(10),
                        ),
                      ),
                      child: const Text('知道了', style: TextStyle(fontSize: 14)),
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final bottomPadding = MediaQuery.of(context).viewInsets.bottom;
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return Padding(
      padding: EdgeInsets.only(
        left: 20,
        right: 20,
        top: 16,
        bottom: bottomPadding + 20,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // 标题
          Text(
            '登录灵译',
            style: TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.bold,
              color: isDark ? Colors.white : Colors.black87,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            '登录后积分跨设备同步',
            style: TextStyle(
              fontSize: 12,
              color: isDark ? Colors.white54 : Colors.black45,
            ),
          ),
          const SizedBox(height: 16),

          // 手机号输入
          TextField(
            controller: _phoneController,
            keyboardType: TextInputType.phone,
            maxLength: 11,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            style: TextStyle(
              fontSize: 14,
              color: isDark ? Colors.white : Colors.black87,
            ),
            decoration: InputDecoration(
              labelText: '手机号',
              labelStyle: const TextStyle(fontSize: 13),
              hintText: '请输入11位手机号',
              hintStyle: const TextStyle(fontSize: 13),
              counterText: '',
              prefixIcon: const Icon(Icons.phone_android, size: 18),
              isDense: true,
              contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(10),
              ),
              filled: true,
              fillColor: isDark ? Colors.white.withValues(alpha: 0.06) : Colors.grey.shade50,
            ),
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: 12),

          // 验证码输入 + 发送按钮
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _codeController,
                  keyboardType: TextInputType.number,
                  maxLength: 6,
                  inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                  style: TextStyle(
                    fontSize: 14,
                    color: isDark ? Colors.white : Colors.black87,
                  ),
                  decoration: InputDecoration(
                    labelText: '验证码',
                    labelStyle: const TextStyle(fontSize: 13),
                    hintText: '6位验证码',
                    hintStyle: const TextStyle(fontSize: 13),
                    counterText: '',
                    prefixIcon: const Icon(Icons.lock_outline, size: 18),
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(10),
                    ),
                    filled: true,
                    fillColor: isDark ? Colors.white.withValues(alpha: 0.06) : Colors.grey.shade50,
                  ),
                  onChanged: (_) => setState(() {}),
                ),
              ),
              const SizedBox(width: 12),
              SizedBox(
                height: 42,
                child: ElevatedButton(
                  onPressed: (_phoneValid && !_sending && _countdown <= 0)
                      ? _sendCode
                      : null,
                  style: ElevatedButton.styleFrom(
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(10),
                    ),
                    padding: const EdgeInsets.symmetric(horizontal: 14),
                  ),
                  child: _sending
                      ? const SizedBox(
                          width: 14,
                          height: 14,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : Text(
                          _countdown > 0 ? '${_countdown}s' : '获取验证码',
                          style: const TextStyle(fontSize: 13),
                        ),
                ),
              ),
            ],
          ),

          // 错误提示
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(
              _error!,
              style: const TextStyle(color: Colors.redAccent, fontSize: 12),
            ),
          ],

          const SizedBox(height: 18),

          // 登录按钮
          SizedBox(
            height: 42,
            child: ElevatedButton(
              onPressed: (_phoneValid && _codeValid && !_logging)
                  ? _login
                  : null,
              style: ElevatedButton.styleFrom(
                backgroundColor: const Color(0xFF4FC3F7),
                foregroundColor: Colors.white,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(10),
                ),
                elevation: 0,
              ),
              child: _logging
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        valueColor: AlwaysStoppedAnimation(Colors.white),
                      ),
                    )
                  : const Text(
                      '登录',
                      style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
                    ),
            ),
          ),

          const SizedBox(height: 8),
          Text(
            '未注册的手机号将自动创建账号',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 11,
              color: isDark ? Colors.white38 : Colors.black26,
            ),
          ),
        ],
      ),
    );
  }
}
