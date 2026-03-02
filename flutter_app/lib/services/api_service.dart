import 'dart:convert';
import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:path/path.dart' as p;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite/sqflite.dart';
import '../models/job.dart';
import 'auth_service.dart';

class ApiService {
  static const _prefKey = 'server_base_url';
  static const _jobsCachePrefix = 'jobs_cache_v1_';
  static const _coversKey = 'jobs_local_covers_v1';
  // 通过 --dart-define=AIRTRANSLATE_API_URL=... 编译时注入
  // 备案前: build_web_release_ip.ps1 默认 http://122.51.10.98/api (同站)
  // 备案后: build_web_release.ps1 传入 http://translate-api.air-inc.top
  static String get _defaultUrl => const String.fromEnvironment(
    'AIRTRANSLATE_API_URL',
    defaultValue: 'http://122.51.10.98/api',
  );

  String _baseUrl = _defaultUrl;
  String? _deviceId;
  Database? _db;

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
    bool useGlossary = false,
  }) async {
    final body = <String, dynamic>{
      'engineType': engineType,
      'output': output,
      'deviceId': deviceId,
      'sourceLang': sourceLang,
      'targetLang': targetLang,
      'sourceFileName': sourceFileName,
      'charCount': charCount,
      'useGlossary': useGlossary,
    };
    final resp = await _post('/jobs/create', body);
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

  /// 标记上传完成（进入待启动状态）
  Future<void> markUploaded(String jobId) async {
    await _post('/jobs/markUploaded', {'jobId': jobId});
  }

  /// 手动启动任务（加入队列）
  Future<void> startJob(String jobId) async {
    await _post('/jobs/start', {'jobId': jobId});
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
    final jobs = list.map((e) => Job.fromJson(e as Map<String, dynamic>)).toList();
    final merged = await _mergeJobsWithLocalCovers(jobs);
    await saveCachedJobs(merged);
    return merged;
  }

  /// 读取本地缓存任务（离线/优先展示）
  /// 缓存中不含 coverImage，需要从 cover map 合并
  Future<List<Job>> getCachedJobs() async {
    final raw = await _loadJobsRaw();
    if (raw == null || raw.isEmpty) return [];
    try {
      final list = (jsonDecode(raw) as List<dynamic>)
          .map((e) => Job.fromJson(e as Map<String, dynamic>))
          .toList();
      return await _mergeJobsWithLocalCovers(list);
    } catch (_) {
      await _removeJobsRaw();
      return [];
    }
  }

  Future<void> saveCachedJobs(List<Job> jobs) async {
    // 缓存时剥离 coverImage，避免 Web localStorage 超限（封面单独存在 cover map 中）
    final data = jobs.map((e) {
      final json = e.toJson();
      json.remove('coverImage');
      return json;
    }).toList();
    final raw = jsonEncode(data);
    if (kIsWeb) {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('$_jobsCachePrefix$deviceId', raw);
      return;
    }
    final db = await _getDb();
    await db.insert(
      'jobs_cache',
      {
        'device_id': deviceId,
        'jobs_json': raw,
        'updated_at': DateTime.now().millisecondsSinceEpoch,
      },
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  Future<void> saveLocalCover(String jobId, String dataUri) async {
    if (jobId.isEmpty || dataUri.isEmpty) return;
    final map = await _loadCoverMap();
    map[jobId] = dataUri;
    await _saveCoverMap(map);

    // 刷新缓存：从服务端拉取最新列表并合并封面
    try {
      await listJobs();
    } catch (_) {
      // 服务端不可达时，cover map 已保存，下次 listJobs 会合并
    }
  }

  Future<void> removeLocalJobData(String jobId) async {
    final map = await _loadCoverMap();
    if (map.remove(jobId) != null) {
      await _saveCoverMap(map);
    }
  }

  /// 删除/取消任务
  Future<Map<String, dynamic>> deleteJob(String jobId) async {
    final resp = await _post('/jobs/delete', {'jobId': jobId});
    await removeLocalJobData(jobId);
    final cached = await getCachedJobs();
    await saveCachedJobs(cached.where((j) => j.jobId != jobId).toList());
    return resp;
  }

  Future<List<Job>> _mergeJobsWithLocalCovers(List<Job> jobs) async {
    final coverMap = await _loadCoverMap();
    return jobs.map((job) {
      if (job.coverImage != null && job.coverImage!.isNotEmpty) return job;
      final local = coverMap[job.jobId];
      if (local == null || local.isEmpty) return job;
      return job.copyWith(coverImage: local);
    }).toList();
  }

  Future<Map<String, String>> _loadCoverMap() async {
    if (kIsWeb) {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_coversKey);
      if (raw == null || raw.isEmpty) return <String, String>{};
      try {
        final decoded = jsonDecode(raw) as Map<String, dynamic>;
        return decoded.map((k, v) => MapEntry(k, '$v'));
      } catch (_) {
        return <String, String>{};
      }
    }
    final db = await _getDb();
    final rows = await db.query('local_covers', columns: ['job_id', 'cover_data']);
    final out = <String, String>{};
    for (final row in rows) {
      final id = '${row['job_id'] ?? ''}';
      final data = '${row['cover_data'] ?? ''}';
      if (id.isNotEmpty && data.isNotEmpty) {
        out[id] = data;
      }
    }
    return out;
  }

  Future<void> _saveCoverMap(Map<String, String> map) async {
    if (kIsWeb) {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_coversKey, jsonEncode(map));
      return;
    }
    final db = await _getDb();
    await db.transaction((txn) async {
      await txn.delete('local_covers');
      final now = DateTime.now().millisecondsSinceEpoch;
      for (final e in map.entries) {
        await txn.insert('local_covers', {
          'job_id': e.key,
          'cover_data': e.value,
          'updated_at': now,
        });
      }
    });
  }

  Future<Database> _getDb() async {
    if (_db != null) return _db!;
    final dbPath = await getDatabasesPath();
    final path = p.join(dbPath, 'air_translate_local.db');
    _db = await openDatabase(
      path,
      version: 1,
      onCreate: (db, version) async {
        await db.execute('''
          CREATE TABLE IF NOT EXISTS jobs_cache(
            device_id TEXT PRIMARY KEY,
            jobs_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          )
        ''');
        await db.execute('''
          CREATE TABLE IF NOT EXISTS local_covers(
            job_id TEXT PRIMARY KEY,
            cover_data TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          )
        ''');
      },
    );
    return _db!;
  }

  Future<String?> _loadJobsRaw() async {
    if (kIsWeb) {
      final prefs = await SharedPreferences.getInstance();
      return prefs.getString('$_jobsCachePrefix$deviceId');
    }
    final db = await _getDb();
    final rows = await db.query(
      'jobs_cache',
      columns: ['jobs_json'],
      where: 'device_id = ?',
      whereArgs: [deviceId],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    return rows.first['jobs_json'] as String?;
  }

  Future<void> _removeJobsRaw() async {
    if (kIsWeb) {
      final prefs = await SharedPreferences.getInstance();
      await prefs.remove('$_jobsCachePrefix$deviceId');
      return;
    }
    final db = await _getDb();
    await db.delete('jobs_cache', where: 'device_id = ?', whereArgs: [deviceId]);
  }

  // -----------------------------------------------------------------------
  // Billing
  // -----------------------------------------------------------------------

  /// 获取服务端配置（积分数量等）
  Future<Map<String, dynamic>> getConfig() async {
    return await _get('/config', {});
  }

  /// 初始化积分（首次赠送）+ 返回余额
  Future<int> initBalance() async {
    final resp = await _post('/billing/init', {'deviceId': deviceId});
    return (resp['balance'] ?? 0) as int;
  }

  /// 查询积分余额
  Future<int> getBalance() async {
    final resp = await _get('/billing/balance', {'deviceId': deviceId});
    return (resp['balance'] ?? 0) as int;
  }

  /// 每日签到，返回 {points, streak, alreadyDone, balance}
  Future<Map<String, dynamic>> checkin() async {
    return await _post('/checkin', {'deviceId': deviceId});
  }

  /// 查询签到状态，返回 {checkedInToday, streak}
  Future<Map<String, dynamic>> checkinStatus() async {
    return await _post('/checkin/status', {'deviceId': deviceId});
  }

  // -----------------------------------------------------------------------
  // HTTP helpers
  // -----------------------------------------------------------------------

  Map<String, String> _buildHeaders() {
    final headers = <String, String>{'Content-Type': 'application/json'};
    if (AuthService.isLoggedIn && AuthService.token.isNotEmpty) {
      headers['X-Auth-Token'] = AuthService.token;
    }
    headers['X-Device-Id'] = deviceId;
    return headers;
  }

  Future<Map<String, dynamic>> _get(String path, Map<String, String> params) async {
    final uri = Uri.parse('$_baseUrl$path').replace(queryParameters: params);
    final resp = await http.get(uri, headers: _buildHeaders()).timeout(const Duration(seconds: 30));
    return _handleResponse(resp);
  }

  Future<Map<String, dynamic>> _post(String path, Map<String, dynamic> body) async {
    final uri = Uri.parse('$_baseUrl$path');
    final resp = await http.post(
      uri,
      headers: _buildHeaders(),
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
