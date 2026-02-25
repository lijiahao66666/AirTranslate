import 'dart:convert';
import 'dart:typed_data';
import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../models/job.dart';

class ApiService {
  static const _prefKey = 'scf_base_url';
  static const _defaultUrl = 'https://1256643821-82t891ur5f.ap-guangzhou.tencentscf.com';

  String _baseUrl = _defaultUrl;
  String? _deviceId;

  static final ApiService _instance = ApiService._();
  factory ApiService() => _instance;
  ApiService._();

  Future<void> init() async {
    final prefs = await SharedPreferences.getInstance();
    _baseUrl = prefs.getString(_prefKey) ?? _defaultUrl;
    _deviceId = await _getOrCreateDeviceId(prefs);
  }

  String get deviceId => _deviceId ?? '';
  String get baseUrl => _baseUrl;

  Future<void> setBaseUrl(String url) async {
    _baseUrl = url.trimRight().replaceAll(RegExp(r'/+$'), '');
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_prefKey, _baseUrl);
  }

  // -----------------------------------------------------------------------
  // Jobs
  // -----------------------------------------------------------------------

  /// 创建翻译任务，返回 {jobId, upload: {url, ...}, glossaryUpload?, pointsDeducted}
  Future<Map<String, dynamic>> createJob({
    required String engineType,
    required String output,
    required String sourceLang,
    required String targetLang,
    required String sourceFileName,
    int charCount = 0,
    bool useContext = false,
    bool useGlossary = false,
  }) async {
    final resp = await _post('/jobs/create', {
      'engineType': engineType,
      'output': output,
      'deviceId': deviceId,
      'sourceLang': sourceLang,
      'targetLang': targetLang,
      'sourceFileName': sourceFileName,
      'charCount': charCount,
      'useContext': useContext,
      'useGlossary': useGlossary,
    });
    return resp;
  }

  /// 上传文件到 presign URL
  Future<void> uploadFile(String presignUrl, Uint8List bytes, String contentType) async {
    final resp = await http.put(
      Uri.parse(presignUrl),
      headers: {'Content-Type': contentType},
      body: bytes,
    );
    if (resp.statusCode < 200 || resp.statusCode >= 300) {
      throw ApiException('Upload failed: ${resp.statusCode}');
    }
  }

  /// 标记上传完成，加入队列
  Future<void> markUploaded(String jobId) async {
    await _post('/jobs/markUploaded', {'jobId': jobId});
  }

  /// 查询任务进度
  Future<JobProgress> getProgress(String jobId) async {
    final resp = await _get('/jobs/progress', {'jobId': jobId});
    return JobProgress.fromJson(resp);
  }

  /// 获取下载 URL
  Future<String> getDownloadUrl(String jobId, {String? output}) async {
    final params = <String, String>{'jobId': jobId};
    if (output != null) params['output'] = output;
    final resp = await _get('/jobs/download', params);
    return resp['url'] as String;
  }

  /// 获取用户任务列表
  Future<List<Job>> listJobs() async {
    final resp = await _get('/jobs/list', {'deviceId': deviceId});
    final list = resp['jobs'] as List<dynamic>? ?? [];
    return list.map((e) => Job.fromJson(e as Map<String, dynamic>)).toList();
  }

  // -----------------------------------------------------------------------
  // Billing
  // -----------------------------------------------------------------------

  /// 查询积分余额
  Future<int> getBalance() async {
    final resp = await _get('/billing/balance', {'deviceId': deviceId});
    return (resp['balance'] ?? 0) as int;
  }

  /// 兑换卡密
  Future<Map<String, dynamic>> redeem(String licenseCode) async {
    return await _post('/billing/redeem', {
      'licenseCode': licenseCode,
      'deviceId': deviceId,
    });
  }

  // -----------------------------------------------------------------------
  // HTTP helpers
  // -----------------------------------------------------------------------

  Future<Map<String, dynamic>> _get(String path, Map<String, String> params) async {
    final uri = Uri.parse('$_baseUrl$path').replace(queryParameters: params);
    final resp = await http.get(uri).timeout(const Duration(seconds: 30));
    return _handleResponse(resp);
  }

  Future<Map<String, dynamic>> _post(String path, Map<String, dynamic> body) async {
    final uri = Uri.parse('$_baseUrl$path');
    final resp = await http.post(
      uri,
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode(body),
    ).timeout(const Duration(seconds: 30));
    return _handleResponse(resp);
  }

  Map<String, dynamic> _handleResponse(http.Response resp) {
    final data = jsonDecode(resp.body) as Map<String, dynamic>;
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      return data;
    }
    final error = data['error'] ?? 'Unknown';
    final message = data['message'] ?? '';
    throw ApiException('$error${message.isNotEmpty ? ': $message' : ''}', statusCode: resp.statusCode, data: data);
  }

  // -----------------------------------------------------------------------
  // Device ID
  // -----------------------------------------------------------------------

  Future<String> _getOrCreateDeviceId(SharedPreferences prefs) async {
    var id = prefs.getString('device_id');
    if (id == null || id.isEmpty) {
      final now = DateTime.now().millisecondsSinceEpoch.toString();
      final random = List.generate(16, (_) => (DateTime.now().microsecond % 256)).join();
      id = sha256.convert(utf8.encode('$now-$random')).toString().substring(0, 32);
      await prefs.setString('device_id', id);
    }
    return id;
  }
}

class ApiException implements Exception {
  final String message;
  final int? statusCode;
  final Map<String, dynamic>? data;

  ApiException(this.message, {this.statusCode, this.data});

  bool get isPointsInsufficient => data?['error'] == 'POINTS_INSUFFICIENT';
  int get needPoints => (data?['need'] ?? 0) as int;
  int get currentBalance => (data?['balance'] ?? 0) as int;

  @override
  String toString() => 'ApiException($statusCode): $message';
}
