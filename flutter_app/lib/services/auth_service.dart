import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'api_service.dart';

/// 用户登录服务（手机号验证码登录）
///
/// 登录后积分绑定到 userId，跨设备互通。
class AuthService {
  AuthService._();

  static const String _kAuthToken = 'auth_token';
  static const String _kUserId = 'auth_user_id';
  static const String _kPhone = 'auth_phone';
  static const String _kIsLoggedIn = 'auth_is_logged_in';

  static String _token = '';
  static String _userId = '';
  static String _phone = '';
  static bool _loggedIn = false;

  /// 回调：登录状态变化时通知外部
  static VoidCallback? onAuthStateChanged;

  static bool get isLoggedIn => _loggedIn;
  static String get token => _token;
  static String get userId => _userId;
  static String get phone => _phone;

  /// 获取有效身份标识: 登录后用 userId, 否则用 deviceId
  static String get effectiveId => _loggedIn && _userId.isNotEmpty ? _userId : ApiService().deviceId;

  /// 启动时从本地缓存恢复登录态
  static Future<void> init() async {
    final prefs = await SharedPreferences.getInstance();
    _token = (prefs.getString(_kAuthToken) ?? '').trim();
    _userId = (prefs.getString(_kUserId) ?? '').trim();
    _phone = (prefs.getString(_kPhone) ?? '').trim();
    _loggedIn = prefs.getBool(_kIsLoggedIn) ?? false;

    // 验证 token 是否仍有效
    if (_loggedIn && _token.isNotEmpty) {
      try {
        final profile = await getProfile();
        if (profile == null) {
          await _clearLocal();
        }
      } catch (_) {
        // 网络错误不清除，保持离线可用
      }
    }

    debugPrint('[Auth] init: loggedIn=$_loggedIn userId=$_userId phone=$_phone');
  }

  /// 发送短信验证码
  static Future<AuthResult> sendSmsCode(String phone) async {
    final baseUrl = ApiService().baseUrl;
    if (baseUrl.isEmpty) {
      return AuthResult(success: false, error: '服务未配置');
    }

    try {
      final resp = await http
          .post(
            Uri.parse('$baseUrl/auth/sms/send'),
            headers: _buildHeaders(),
            body: jsonEncode({'phone': phone}),
          )
          .timeout(const Duration(seconds: 15));

      final json = jsonDecode(resp.body);
      if (resp.statusCode == 200 && json['success'] == true) {
        return AuthResult(success: true);
      }
      return AuthResult(
        success: false,
        error: json['message'] ?? json['error'] ?? '发送失败',
      );
    } catch (e) {
      debugPrint('[Auth] sendSmsCode error: $e');
      return AuthResult(success: false, error: '网络错误，请检查网络');
    }
  }

  /// 验证码登录（自动注册）
  static Future<AuthResult> loginWithSmsCode(String phone, String code) async {
    final baseUrl = ApiService().baseUrl;
    if (baseUrl.isEmpty) {
      return AuthResult(success: false, error: '服务未配置');
    }

    try {
      final headers = _buildHeaders();
      headers['X-Device-Id'] = ApiService().deviceId;

      final resp = await http
          .post(
            Uri.parse('$baseUrl/auth/sms/verify'),
            headers: headers,
            body: jsonEncode({
              'phone': phone,
              'code': code,
              'deviceId': ApiService().deviceId,
            }),
          )
          .timeout(const Duration(seconds: 15));

      final json = jsonDecode(resp.body);
      if (resp.statusCode == 200 && json['token'] != null) {
        _token = json['token'];
        _userId = json['userId'] ?? '';
        _phone = json['phone'] ?? '';
        _loggedIn = true;

        final prefs = await SharedPreferences.getInstance();
        await prefs.setString(_kAuthToken, _token);
        await prefs.setString(_kUserId, _userId);
        await prefs.setString(_kPhone, _phone);
        await prefs.setBool(_kIsLoggedIn, true);

        onAuthStateChanged?.call();
        debugPrint('[Auth] login success: userId=$_userId phone=$_phone isNew=${json['isNewUser']}');
        return AuthResult(
          success: true,
          balance: (json['balance'] as num?)?.toInt(),
          isNewUser: json['isNewUser'] == true,
        );
      }

      return AuthResult(
        success: false,
        error: json['message'] ?? json['error'] ?? '登录失败',
      );
    } catch (e) {
      debugPrint('[Auth] loginWithSmsCode error: $e');
      return AuthResult(success: false, error: '网络错误，请检查网络');
    }
  }

  /// 获取用户信息
  static Future<Map<String, dynamic>?> getProfile() async {
    final baseUrl = ApiService().baseUrl;
    if (baseUrl.isEmpty || _token.isEmpty) return null;

    try {
      final resp = await http
          .post(
            Uri.parse('$baseUrl/auth/profile'),
            headers: _buildHeaders(withAuth: true),
          )
          .timeout(const Duration(seconds: 10));

      if (resp.statusCode == 200) {
        return jsonDecode(resp.body);
      }
      if (resp.statusCode == 401) {
        return null;
      }
    } catch (e) {
      debugPrint('[Auth] getProfile error: $e');
      rethrow;
    }
    return null;
  }

  /// 退出登录
  static Future<void> logout() async {
    final baseUrl = ApiService().baseUrl;
    if (baseUrl.isNotEmpty && _token.isNotEmpty) {
      try {
        final headers = _buildHeaders(withAuth: true);
        headers['X-Device-Id'] = ApiService().deviceId;
        await http
            .post(
              Uri.parse('$baseUrl/auth/logout'),
              headers: headers,
            )
            .timeout(const Duration(seconds: 5));
      } catch (_) {}
    }
    await _clearLocal();
    onAuthStateChanged?.call();
    debugPrint('[Auth] logged out');
  }

  static Future<void> _clearLocal() async {
    _token = '';
    _userId = '';
    _phone = '';
    _loggedIn = false;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_kAuthToken);
    await prefs.remove(_kUserId);
    await prefs.remove(_kPhone);
    await prefs.setBool(_kIsLoggedIn, false);
  }

  static const String _apiKey =
      String.fromEnvironment('AIRTRANSLATE_API_KEY', defaultValue: '');

  static Map<String, String> _buildHeaders({bool withAuth = false}) {
    final headers = <String, String>{
      'Content-Type': 'application/json',
    };
    final key = _apiKey.trim();
    if (key.isNotEmpty) headers['X-Api-Key'] = key;
    if (withAuth && _token.isNotEmpty) headers['X-Auth-Token'] = _token;
    return headers;
  }
}

class AuthResult {
  final bool success;
  final String? error;
  final int? balance;
  final bool isNewUser;

  AuthResult({
    required this.success,
    this.error,
    this.balance,
    this.isNewUser = false,
  });
}
