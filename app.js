'use strict';

// =========================================================================
// AirTranslate Server (v4 - local filesystem)
// - 积分/任务/进度/队列: 本地文件系统 ./data/
// - COS: 仅用于 presign URL (EPUB 上传/下载/术语表)
// - /jobs/*    : App 面向的 API
// - /billing/* : 积分 API
// - /worker/*  : Worker 内部 API (获取队列/更新进度/完成/失败)
// - 端口 9001 (避免和 AirRead 的 9000 冲突)
// =========================================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');

// ---------------------------------------------------------------------------
// 加载 .env 文件 (零依赖)
// ---------------------------------------------------------------------------

(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
})();

// ---------------------------------------------------------------------------
// 数据目录初始化
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, 'data');
const DIRS = {
  points:   path.join(DATA_DIR, 'points'),
  jobs:     path.join(DATA_DIR, 'jobs'),
  queue:    path.join(DATA_DIR, 'queue'),
};

for (const dir of Object.values(DIRS)) {
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// 本地文件辅助
// ---------------------------------------------------------------------------

function readJsonFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function writeJsonFile(filePath, obj) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

function sha1Hex(s) {
  return crypto.createHash('sha1').update(String(s || ''), 'utf8').digest('hex');
}

function hmacSha1Hex(key, msg) {
  return crypto.createHmac('sha1', String(key || '')).update(String(msg || ''), 'utf8').digest('hex');
}

function uriEncode(s) {
  return encodeURIComponent(String(s || '')).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// ---------------------------------------------------------------------------
// COS presign 相关 (仅用于生成签名 URL, 不做数据存储)
// ---------------------------------------------------------------------------

function getCosConfig() {
  const bucket = (process.env.COS_BUCKET || '').trim();
  const region = (process.env.COS_REGION || '').trim();
  const cosPrefix = String(process.env.COS_PREFIX || 'translate/').trim() || 'translate/';
  const presignSeconds = Number(process.env.COS_PRESIGN_EXPIRES_SECONDS || '7200') || 7200;
  return { bucket, region, cosPrefix, presignSeconds };
}

function getCosCredentials() {
  const secretId = (process.env.TENCENT_SECRET_ID || process.env.COS_SECRET_ID || '').trim();
  const secretKey = (process.env.TENCENT_SECRET_KEY || process.env.COS_SECRET_KEY || '').trim();
  const sessionToken = (process.env.COS_SESSION_TOKEN || '').trim();
  return { secretId, secretKey, sessionToken };
}

function buildCosAuthorization({ secretId, secretKey, method, path, headers, query, startTime, endTime }) {
  const signTime = `${startTime};${endTime}`;
  const signKey = hmacSha1Hex(secretKey, signTime);
  const headerKeys = Object.keys(headers || {}).map((k) => k.toLowerCase()).sort();
  const headerList = headerKeys.join(';');
  const headerString = headerKeys.map((k) => `${k}=${uriEncode(String(headers[k] ?? '').trim())}`).join('&');
  const queryKeys = Object.keys(query || {}).map((k) => k.toLowerCase()).sort();
  const queryList = queryKeys.join(';');
  const queryString = queryKeys.map((k) => `${k}=${uriEncode(String(query[k] ?? '').trim())}`).join('&');
  const formatString = [String(method || 'get').toLowerCase(), path, queryString, headerString, ''].join('\n');
  const stringToSign = ['sha1', signTime, sha1Hex(formatString), ''].join('\n');
  const signature = hmacSha1Hex(signKey, stringToSign);
  return `q-sign-algorithm=sha1&q-ak=${secretId}&q-sign-time=${signTime}&q-key-time=${signTime}&q-header-list=${headerList}&q-url-param-list=${queryList}&q-signature=${signature}`;
}

function buildCosPath(key) {
  return '/' + String(key || '').split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

function buildCosKey(relativeKey) {
  const { cosPrefix } = getCosConfig();
  let prefix = cosPrefix;
  if (!prefix.endsWith('/')) prefix += '/';
  let rel = String(relativeKey || '');
  if (rel.startsWith('/')) rel = rel.slice(1);
  return prefix + rel;
}

function cosPresignUrl({ method, key, expiresSeconds, headers, query }) {
  const { bucket, region } = getCosConfig();
  const { secretId, secretKey, sessionToken } = getCosCredentials();
  if (!secretId || !secretKey || !bucket || !region) throw new Error('Missing COS config');
  const host = `${bucket}.cos.${region}.myqcloud.com`;
  const cosPath = buildCosPath(key);
  const finalHeaders = Object.assign({}, headers || {});
  finalHeaders.host = host;
  const finalQuery = Object.assign({}, query || {});
  const now = Math.floor(Date.now() / 1000);
  const sign = buildCosAuthorization({ secretId, secretKey, method, path: cosPath, headers: finalHeaders, query: finalQuery, startTime: now - 60, endTime: now + Math.max(60, Math.min(86400, Number(expiresSeconds) || 7200)) });
  const tokenPart = sessionToken ? `&x-cos-security-token=${encodeURIComponent(sessionToken)}` : '';
  const extraQuery = Object.keys(finalQuery).map(k => `${encodeURIComponent(k)}=${encodeURIComponent(finalQuery[k])}`).join('&');
  const extraPart = extraQuery ? `&${extraQuery}` : '';
  return `https://${host}${cosPath}?${sign}${tokenPart}${extraPart}`;
}

// ---------------------------------------------------------------------------
// HTTP 辅助
// ---------------------------------------------------------------------------

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk.toString('utf8'); if (data.length > 4 * 1024 * 1024) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => { if (!data.trim()) return resolve({}); try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function normalizeOutput(output) {
  return String(output || '').trim().toUpperCase() === 'BILINGUAL' ? 'BILINGUAL' : 'TRANSLATED_ONLY';
}

function normalizeEngineType(engine) {
  const e = String(engine || '').trim().toUpperCase();
  if (e === 'AI' || e === 'HY') return 'AI';
  return 'MACHINE';
}

// ---------------------------------------------------------------------------
// Worker 密钥验证
// ---------------------------------------------------------------------------

function verifyWorkerKey(req) {
  const key = (process.env.WORKER_API_KEY || '').trim();
  if (!key) return true; // 未配置则跳过
  const header = (req.headers['x-worker-key'] || '').trim();
  return header === key;
}

// ---------------------------------------------------------------------------
// 远程配置 (config.json)
// ---------------------------------------------------------------------------

const CONFIG_FILE = path.join(__dirname, 'config.json');
const DEFAULT_CONFIG = {
  checkin_enabled: true,
  checkin_points: 5000,
  initial_grant_points: 500000,
  billing_unit_chars: 1000,
  billing_unit_cost: 1,
  latest_version: '1.0.0',
  min_version: '1.0.0',
  update_url: '',
  announcement: '',
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      return { ...DEFAULT_CONFIG, ...saved };
    }
  } catch (e) {
    console.error('[config] Failed to load config.json:', e.message);
  }
  return DEFAULT_CONFIG;
}

if (!fs.existsSync(CONFIG_FILE)) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
  console.log('[config] Created default ' + CONFIG_FILE);
}

// ---------------------------------------------------------------------------
// 启动迁移：清理 job.json 中的 coverImage 字段（体积过大导致 API 超时）
// ---------------------------------------------------------------------------
try {
  const jobDirs = fs.existsSync(DIRS.jobs) ? fs.readdirSync(DIRS.jobs) : [];
  let cleaned = 0;
  for (const jobId of jobDirs) {
    const jobFile = path.join(DIRS.jobs, jobId, 'job.json');
    try {
      if (!fs.existsSync(jobFile)) continue;
      const raw = fs.readFileSync(jobFile, 'utf-8');
      if (!raw.includes('coverImage')) continue;
      const obj = JSON.parse(raw);
      if (obj.coverImage) {
        delete obj.coverImage;
        fs.writeFileSync(jobFile, JSON.stringify(obj, null, 2), 'utf-8');
        cleaned++;
      }
    } catch (_) {}
  }
  if (cleaned > 0) console.log(`[migrate] Stripped coverImage from ${cleaned} job(s)`);
} catch (_) {}

// ---------------------------------------------------------------------------
// 积分管理 (本地文件)
// ---------------------------------------------------------------------------

function _readPointsData(deviceId) {
  const filePath = path.join(DIRS.points, `${deviceId}.json`);
  return readJsonFile(filePath) || {};
}

function _writePointsData(deviceId, obj) {
  const filePath = path.join(DIRS.points, `${deviceId}.json`);
  obj.updatedAt = new Date().toISOString();
  writeJsonFile(filePath, obj);
}

function readPointsBalance(deviceId) {
  const data = _readPointsData(deviceId);
  const balance = Number(data.balance || 0);
  return balance < 0 ? 0 : balance;
}

function writePointsBalance(deviceId, balance) {
  const data = _readPointsData(deviceId);
  data.balance = balance < 0 ? 0 : balance;
  _writePointsData(deviceId, data);
  return data.balance;
}

function ensureInitialGrant(deviceId) {
  const data = _readPointsData(deviceId);
  if (!data.initialGranted) {
    const cfg = loadConfig();
    data.balance = (Number(data.balance) || 0) + cfg.initial_grant_points;
    data.initialGranted = true;
    _writePointsData(deviceId, data);
    console.log(`[points] initial grant ${cfg.initial_grant_points} to ${deviceId}`);
  }
  return Number(data.balance) || 0;
}

function doCheckin(deviceId) {
  const today = new Date().toISOString().substring(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().substring(0, 10);
  const data = _readPointsData(deviceId);

  const lastCheckin = data.lastCheckinDate || '';
  if (lastCheckin === today) {
    return { points: 0, streak: data.checkinStreak || 0, alreadyDone: true, balance: Number(data.balance) || 0 };
  }

  let streak = Number(data.checkinStreak || 0);
  streak = (lastCheckin === yesterday) ? streak + 1 : 1;

  const cfg = loadConfig();
  data.balance = (Number(data.balance) || 0) + cfg.checkin_points;
  data.lastCheckinDate = today;
  data.checkinStreak = streak;
  _writePointsData(deviceId, data);
  console.log(`[checkin] ${deviceId} +${cfg.checkin_points} streak=${streak}`);
  return { points: cfg.checkin_points, streak, alreadyDone: false, balance: data.balance };
}

// ---------------------------------------------------------------------------
// 任务管理 (本地文件)
// ---------------------------------------------------------------------------

function getJobDir(jobId) {
  return path.join(DIRS.jobs, jobId);
}

function readJobSpec(jobId) {
  return readJsonFile(path.join(getJobDir(jobId), 'job.json'));
}

function writeJobSpec(jobId, spec) {
  writeJsonFile(path.join(getJobDir(jobId), 'job.json'), spec);
}

function readProgress(jobId) {
  return readJsonFile(path.join(getJobDir(jobId), 'progress.json'));
}

function writeProgress(jobId, progress) {
  writeJsonFile(path.join(getJobDir(jobId), 'progress.json'), progress);
}

// ---------------------------------------------------------------------------
// 队列管理 (本地文件: data/queue/{jobId}.json)
// ---------------------------------------------------------------------------

function enqueue(jobId) {
  writeJsonFile(path.join(DIRS.queue, `${jobId}.json`), { jobId, enqueuedAt: new Date().toISOString() });
}

function dequeue(jobId) {
  const filePath = path.join(DIRS.queue, `${jobId}.json`);
  try { fs.unlinkSync(filePath); } catch (_) {}
}

function isQueued(jobId) {
  const filePath = path.join(DIRS.queue, `${jobId}.json`);
  return fs.existsSync(filePath);
}

function peekQueue() {
  try {
    const files = fs.readdirSync(DIRS.queue).filter((f) => f.endsWith('.json')).sort();
    if (files.length === 0) return null;
    const data = readJsonFile(path.join(DIRS.queue, files[0]));
    return data ? data.jobId : files[0].replace('.json', '');
  } catch (_) {
    return null;
  }
}

function listQueue(limit = 5) {
  try {
    const files = fs.readdirSync(DIRS.queue).filter((f) => f.endsWith('.json')).sort();
    const ids = [];
    for (const f of files) {
      if (ids.length >= limit) break;
      const data = readJsonFile(path.join(DIRS.queue, f));
      const id = data ? data.jobId : f.replace('.json', '');
      // 跳过已完成/已取消的僵尸队列项
      const progress = readProgress(id);
      if (progress && (progress.state === 'DONE' || progress.state === 'CANCELED')) {
        dequeue(id);
        continue;
      }
      ids.push(id);
    }
    return ids;
  } catch (_) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// API: POST /jobs/create
// ---------------------------------------------------------------------------

function handleCreateJob(res, body) {
  const { bucket, region } = getCosConfig();
  if (!bucket || !region) return sendJson(res, 500, { error: 'ServerMisconfiguration', message: 'COS not configured' });

  const engineType = normalizeEngineType(body.engineType || body.engine);
  const output = normalizeOutput(body.output);
  const deviceId = String(body.deviceId || body.device_id || '').trim();
  const sourceLang = String(body.sourceLang || body.source_lang || 'auto').trim() || 'auto';
  const targetLang = String(body.targetLang || body.target_lang || '').trim();
  const sourceFileName = String(body.sourceFileName || body.source_file_name || '').trim();
  const charCount = Number(body.charCount || 0) || 0;
  const useContext = Boolean(body.useContext);
  const useGlossary = Boolean(body.useGlossary);
  const translateMode = String(body.translateMode || 'PARAGRAPH').trim().toUpperCase() === 'CHAPTER' ? 'CHAPTER' : 'PARAGRAPH';

  if (!targetLang) return sendJson(res, 400, { error: 'BadRequest', message: 'targetLang required' });
  if (!sourceFileName) return sendJson(res, 400, { error: 'BadRequest', message: 'sourceFileName required' });
  if (!deviceId) return sendJson(res, 400, { error: 'BadRequest', message: 'deviceId required' });

  // AI翻译: 预扣积分
  let pointsDeducted = 0;
  if (engineType === 'AI' && charCount > 0) {
    const cfg = loadConfig();
    pointsDeducted = Math.ceil(charCount / cfg.billing_unit_chars) * cfg.billing_unit_cost;
    const balance = readPointsBalance(deviceId);
    if (balance < pointsDeducted) {
      return sendJson(res, 409, { error: 'POINTS_INSUFFICIENT', need: pointsDeducted, balance });
    }
    writePointsBalance(deviceId, balance - pointsDeducted);
  }

  const jobId = crypto.randomBytes(16).toString('hex');
  const nowIso = new Date().toISOString();
  const { presignSeconds } = getCosConfig();

  const spec = {
    jobId, engineType, output, deviceId, sourceLang, targetLang,
    sourceFileName, charCount, useContext, useGlossary, translateMode,
    pointsDeducted, createdAt: nowIso,
  };
  const progress = { jobId, state: 'CREATED', percent: 0, engineType, output, updatedAt: nowIso };

  writeJobSpec(jobId, spec);
  writeProgress(jobId, progress);

  // 生成 COS presign URL (EPUB 上传)
  const sourceKey = buildCosKey(`${jobId}/source.epub`);
  const uploadUrl = cosPresignUrl({ method: 'PUT', key: sourceKey, expiresSeconds: presignSeconds, headers: { 'content-type': 'application/epub+zip' } });

  // 术语表上传 URL (AI + useGlossary)
  let glossaryUpload = null;
  if (engineType === 'AI' && useGlossary) {
    const glossaryKey = buildCosKey(`${jobId}/glossary.json`);
    const glossaryUrl = cosPresignUrl({ method: 'PUT', key: glossaryKey, expiresSeconds: presignSeconds, headers: { 'content-type': 'application/json' } });
    glossaryUpload = { cosKey: glossaryKey, url: glossaryUrl, method: 'PUT', contentType: 'application/json' };
  }

  return sendJson(res, 200, {
    jobId,
    pointsDeducted,
    upload: { cosKey: sourceKey, url: uploadUrl, method: 'PUT', contentType: 'application/epub+zip', expiresInSeconds: presignSeconds },
    glossaryUpload,
  });
}

// ---------------------------------------------------------------------------
// API: POST /jobs/markUploaded  (App上传完EPUB后调用，标记为待启动)
// ---------------------------------------------------------------------------

function handleMarkUploaded(res, body) {
  const jobId = String(body.jobId || '').trim();
  if (!jobId) return sendJson(res, 400, { error: 'BadRequest', message: 'jobId required' });

  const progress = readProgress(jobId);
  if (!progress) return sendJson(res, 404, { error: 'NotFound' });

  progress.state = 'READY';
  progress.updatedAt = new Date().toISOString();
  writeProgress(jobId, progress);

  return sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// API: POST /jobs/start  (用户手动启动翻译，加入队列)
// ---------------------------------------------------------------------------

function handleStartJob(res, body) {
  const jobId = String(body.jobId || '').trim();
  if (!jobId) return sendJson(res, 400, { error: 'BadRequest', message: 'jobId required' });

  const progress = readProgress(jobId);
  if (!progress) return sendJson(res, 404, { error: 'NotFound' });

  const state = String(progress.state || 'CREATED').toUpperCase();
  if (state === 'DONE' || state === 'FAILED') {
    return sendJson(res, 409, { error: 'InvalidState', message: `cannot start from state ${state}` });
  }
  if (state !== 'READY' && state !== 'UPLOADED') {
    return sendJson(res, 409, { error: 'InvalidState', message: `cannot start from state ${state}` });
  }

  if (!isQueued(jobId)) {
    enqueue(jobId);
  }

  progress.state = 'UPLOADED';
  progress.updatedAt = new Date().toISOString();
  writeProgress(jobId, progress);

  return sendJson(res, 200, { ok: true, queued: true });
}

// ---------------------------------------------------------------------------
// API: GET /jobs/progress
// ---------------------------------------------------------------------------

function handleGetProgress(res, jobId) {
  if (!jobId) return sendJson(res, 400, { error: 'BadRequest', message: 'jobId required' });

  const progress = readProgress(jobId);
  if (!progress) return sendJson(res, 404, { error: 'NotFound' });

  // 失败时自动退还积分
  if (progress.state === 'FAILED' && !progress._refunded) {
    const job = readJobSpec(jobId);
    if (job && job.pointsDeducted > 0 && job.deviceId) {
      const cur = readPointsBalance(job.deviceId);
      writePointsBalance(job.deviceId, cur + job.pointsDeducted);
      progress._refunded = true;
      progress.refundedPoints = job.pointsDeducted;
      writeProgress(jobId, progress);
    }
  }

  return sendJson(res, 200, progress);
}

// ---------------------------------------------------------------------------
// API: GET /jobs/download
// ---------------------------------------------------------------------------

function handleGetDownloadUrl(res, jobId, output) {
  if (!jobId) return sendJson(res, 400, { error: 'BadRequest', message: 'jobId required' });

  const progress = readProgress(jobId);
  if (!progress) return sendJson(res, 404, { error: 'NotFound' });
  if (String(progress.state || '').toUpperCase() !== 'DONE') {
    return sendJson(res, 409, { error: 'NotReady', message: 'job not done' });
  }

  const spec = readJobSpec(jobId);
  const { presignSeconds } = getCosConfig();
  const o = normalizeOutput(output || progress.output);
  const cosKey = o === 'BILINGUAL' ? buildCosKey(`${jobId}/bilingual.epub`) : buildCosKey(`${jobId}/translated.epub`);

  // 下载文件名: 原书名_译本.epub
  const baseName = String(spec?.sourceFileName || 'book').replace(/\.epub$/i, '');
  const suffix = o === 'BILINGUAL' ? '_双语译本' : '_译本';
  const downloadName = `${baseName}${suffix}.epub`;
  const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;

  const url = cosPresignUrl({ method: 'GET', key: cosKey, expiresSeconds: presignSeconds, headers: {}, query: { 'response-content-disposition': disposition } });
  return sendJson(res, 200, { cosKey, url, expiresInSeconds: presignSeconds });
}

// ---------------------------------------------------------------------------
// API: GET /jobs/list
// ---------------------------------------------------------------------------

function handleListJobs(res, deviceId) {
  if (!deviceId) return sendJson(res, 400, { error: 'BadRequest', message: 'deviceId required' });

  const jobs = [];
  try {
    const dirs = fs.readdirSync(DIRS.jobs);
    for (const jobId of dirs) {
      const job = readJobSpec(jobId);
      if (job && job.deviceId === deviceId) {
        const progress = readProgress(jobId) || {};
        // 列表接口不返回 coverImage（体积过大会导致超时）
        const { coverImage: _, ...jobWithoutCover } = job;
        jobs.push({ ...jobWithoutCover, progress });
      }
    }
  } catch (_) {}

  // 按创建时间倒序
  jobs.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return sendJson(res, 200, { jobs });
}

// ---------------------------------------------------------------------------
// API: POST /jobs/delete  — 删除/取消任务
// ---------------------------------------------------------------------------

function handleDeleteJob(res, body) {
  const jobId = String(body.jobId || '').trim();
  if (!jobId) return sendJson(res, 400, { error: 'BadRequest', message: 'jobId required' });

  const spec = readJobSpec(jobId);
  if (!spec) return sendJson(res, 404, { error: 'NotFound' });

  const progress = readProgress(jobId) || {};
  const state = String(progress.state || 'CREATED').toUpperCase();

  // 从队列中移除
  dequeue(jobId);

  // 退还积分（仅未开始翻译的 AI 任务：CREATED / READY / UPLOADED）
  let refunded = 0;
  const canRefund = (state === 'CREATED' || state === 'READY' || state === 'UPLOADED');
  if (canRefund && spec.pointsDeducted > 0 && spec.deviceId && !progress._refunded) {
    const cur = readPointsBalance(spec.deviceId);
    writePointsBalance(spec.deviceId, cur + spec.pointsDeducted);
    refunded = spec.pointsDeducted;
    console.log(`[delete] refund ${refunded} to ${spec.deviceId} for job ${jobId}`);
  }

  // 删除任务目录
  const jobDir = getJobDir(jobId);
  try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (_) {}

  return sendJson(res, 200, { ok: true, refundedPoints: refunded });
}

// ---------------------------------------------------------------------------
// API: GET /billing/balance
// ---------------------------------------------------------------------------

function handleBalance(res, deviceId) {
  if (!deviceId) return sendJson(res, 400, { error: 'BadRequest', message: 'deviceId required' });
  const balance = readPointsBalance(deviceId);
  return sendJson(res, 200, { deviceId, balance });
}

// ---------------------------------------------------------------------------
// API: POST /billing/init  — 初始化积分（首次赠送）+ 返回余额
// ---------------------------------------------------------------------------

function handleBillingInit(res, body) {
  const deviceId = String(body.deviceId || '').trim();
  if (!deviceId) return sendJson(res, 400, { error: 'BadRequest', message: 'deviceId required' });
  const balance = ensureInitialGrant(deviceId);
  return sendJson(res, 200, { deviceId, balance });
}

// ---------------------------------------------------------------------------
// API: POST /checkin  — 每日签到
// ---------------------------------------------------------------------------

function handleCheckin(res, body) {
  const deviceId = String(body.deviceId || '').trim();
  if (!deviceId) return sendJson(res, 400, { error: 'BadRequest', message: 'deviceId required' });
  const result = doCheckin(deviceId);
  return sendJson(res, 200, result);
}

// ---------------------------------------------------------------------------
// API: POST /checkin/status  — 查询签到状态
// ---------------------------------------------------------------------------

function handleCheckinStatus(res, body) {
  const deviceId = String(body.deviceId || '').trim();
  if (!deviceId) return sendJson(res, 400, { error: 'BadRequest', message: 'deviceId required' });
  const data = _readPointsData(deviceId);
  const today = new Date().toISOString().substring(0, 10);
  const done = data.lastCheckinDate === today;
  const streak = Number(data.checkinStreak || 0);
  return sendJson(res, 200, { checkedInToday: done, streak });
}

// ---------------------------------------------------------------------------
// Worker API: GET /worker/poll  — 获取下一个待处理任务
// ---------------------------------------------------------------------------

function handleWorkerPoll(req, res) {
  if (!verifyWorkerKey(req)) return sendJson(res, 403, { error: 'Forbidden' });

  const jobId = peekQueue();
  if (!jobId) return sendJson(res, 200, { jobId: null });

  const job = readJobSpec(jobId);
  if (!job) {
    // 无效队列项，清除
    dequeue(jobId);
    return sendJson(res, 200, { jobId: null });
  }

  const progress = readProgress(jobId);
  if (progress && (progress.state === 'DONE' || progress.state === 'CANCELED')) {
    dequeue(jobId);
    return sendJson(res, 200, { jobId: null });
  }

  // 生成 COS presign URL 供 Worker 下载源文件 & 上传结果
  const { presignSeconds } = getCosConfig();
  const sourceKey = buildCosKey(`${jobId}/source.epub`);
  const sourceDownloadUrl = cosPresignUrl({ method: 'GET', key: sourceKey, expiresSeconds: presignSeconds, headers: {} });

  const bilingualKey = buildCosKey(`${jobId}/bilingual.epub`);
  const bilingualUploadUrl = cosPresignUrl({ method: 'PUT', key: bilingualKey, expiresSeconds: presignSeconds, headers: { 'content-type': 'application/epub+zip' } });

  const translatedKey = buildCosKey(`${jobId}/translated.epub`);
  const translatedUploadUrl = cosPresignUrl({ method: 'PUT', key: translatedKey, expiresSeconds: presignSeconds, headers: { 'content-type': 'application/epub+zip' } });

  // 术语表下载 URL
  let glossaryDownloadUrl = null;
  if (job.engineType === 'AI' && job.useGlossary) {
    const glossaryKey = buildCosKey(`${jobId}/glossary.json`);
    glossaryDownloadUrl = cosPresignUrl({ method: 'GET', key: glossaryKey, expiresSeconds: presignSeconds, headers: {} });
  }

  return sendJson(res, 200, {
    jobId,
    job,
    cos: {
      sourceDownloadUrl,
      bilingualUploadUrl,
      translatedUploadUrl,
      glossaryDownloadUrl,
    },
  });
}

// ---------------------------------------------------------------------------
// Worker API: GET /worker/poll-batch  — 批量获取待处理任务 (窗口调度)
// ---------------------------------------------------------------------------

function handleWorkerPollBatch(req, res) {
  if (!verifyWorkerKey(req)) return sendJson(res, 403, { error: 'Forbidden' });

  const url = new URL(req.url || '/', 'http://localhost');
  const limit = Math.min(Number(url.searchParams.get('limit') || '5') || 5, 20);

  const jobIds = listQueue(limit);
  if (jobIds.length === 0) return sendJson(res, 200, { jobs: [] });

  const { presignSeconds } = getCosConfig();
  const jobs = [];

  for (const jobId of jobIds) {
    const job = readJobSpec(jobId);
    if (!job) { dequeue(jobId); continue; }

    const sourceKey = buildCosKey(`${jobId}/source.epub`);
    const sourceDownloadUrl = cosPresignUrl({ method: 'GET', key: sourceKey, expiresSeconds: presignSeconds, headers: {} });
    const bilingualKey = buildCosKey(`${jobId}/bilingual.epub`);
    const bilingualUploadUrl = cosPresignUrl({ method: 'PUT', key: bilingualKey, expiresSeconds: presignSeconds, headers: { 'content-type': 'application/epub+zip' } });
    const translatedKey = buildCosKey(`${jobId}/translated.epub`);
    const translatedUploadUrl = cosPresignUrl({ method: 'PUT', key: translatedKey, expiresSeconds: presignSeconds, headers: { 'content-type': 'application/epub+zip' } });

    let glossaryDownloadUrl = null;
    if (job.engineType === 'AI' && job.useGlossary) {
      const glossaryKey = buildCosKey(`${jobId}/glossary.json`);
      glossaryDownloadUrl = cosPresignUrl({ method: 'GET', key: glossaryKey, expiresSeconds: presignSeconds, headers: {} });
    }

    jobs.push({
      jobId,
      job,
      cos: { sourceDownloadUrl, bilingualUploadUrl, translatedUploadUrl, glossaryDownloadUrl },
    });
  }

  return sendJson(res, 200, { jobs });
}

// ---------------------------------------------------------------------------
// Worker API: POST /worker/progress  — 更新任务进度
// ---------------------------------------------------------------------------

function handleWorkerProgress(req, res, body) {
  if (!verifyWorkerKey(req)) return sendJson(res, 403, { error: 'Forbidden' });

  const jobId = String(body.jobId || '').trim();
  if (!jobId) return sendJson(res, 400, { error: 'BadRequest', message: 'jobId required' });

  const progress = readProgress(jobId);
  if (!progress) return sendJson(res, 404, { error: 'NotFound' });

  // 合并更新
  if (body.state) progress.state = body.state;
  if (body.percent != null) progress.percent = Number(body.percent);
  if (body.chapterIndex != null) progress.chapterIndex = Number(body.chapterIndex);
  if (body.chapterTotal != null) progress.chapterTotal = Number(body.chapterTotal);
  if (body.engineType) progress.engineType = body.engineType;
  if (body.output) progress.output = body.output;
  progress.updatedAt = new Date().toISOString();

  writeProgress(jobId, progress);
  return sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// Worker API: POST /worker/complete  — 任务完成
// ---------------------------------------------------------------------------

function handleWorkerComplete(req, res, body) {
  if (!verifyWorkerKey(req)) return sendJson(res, 403, { error: 'Forbidden' });

  const jobId = String(body.jobId || '').trim();
  if (!jobId) return sendJson(res, 400, { error: 'BadRequest', message: 'jobId required' });

  const progress = readProgress(jobId);
  if (!progress) return sendJson(res, 404, { error: 'NotFound' });

  progress.state = 'DONE';
  progress.percent = 100;
  progress.updatedAt = new Date().toISOString();
  writeProgress(jobId, progress);

  // 从队列移除
  dequeue(jobId);

  return sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// Worker API: POST /worker/fail  — 任务失败
// ---------------------------------------------------------------------------

function handleWorkerFail(req, res, body) {
  if (!verifyWorkerKey(req)) return sendJson(res, 403, { error: 'Forbidden' });

  const jobId = String(body.jobId || '').trim();
  if (!jobId) return sendJson(res, 400, { error: 'BadRequest', message: 'jobId required' });

  const progress = readProgress(jobId);
  if (!progress) return sendJson(res, 404, { error: 'NotFound' });

  progress.state = 'FAILED';
  progress.error = body.error || { code: 'JOB_FAILED', message: 'Unknown error' };
  progress.updatedAt = new Date().toISOString();
  writeProgress(jobId, progress);

  // 从队列移除
  dequeue(jobId);

  // 自动退还积分
  const job = readJobSpec(jobId);
  if (job && job.pointsDeducted > 0 && job.deviceId) {
    const cur = readPointsBalance(job.deviceId);
    writePointsBalance(job.deviceId, cur + job.pointsDeducted);
    progress._refunded = true;
    progress.refundedPoints = job.pointsDeducted;
    writeProgress(jobId, progress);
  }

  return sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization,accept,x-worker-key,x-device-id');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.end();
    return;
  }

  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname || '/';

  // Health check
  if (req.method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, { status: 'ok', service: 'AirTranslate', uptime: process.uptime() });
  }

  let body = {};
  if (req.method === 'POST') {
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'InvalidJson', message: String(e?.message || e) }); }
  }

  try {
    // --- Jobs (App-facing) ---
    if (req.method === 'POST' && pathname === '/jobs/create') return handleCreateJob(res, body);
    if (req.method === 'POST' && pathname === '/jobs/markUploaded') return handleMarkUploaded(res, body);
    if (req.method === 'POST' && pathname === '/jobs/start') return handleStartJob(res, body);
    if (req.method === 'GET' && pathname === '/jobs/progress') return handleGetProgress(res, String(url.searchParams.get('jobId') || '').trim());
    if (req.method === 'GET' && pathname === '/jobs/download') return handleGetDownloadUrl(res, String(url.searchParams.get('jobId') || '').trim(), url.searchParams.get('output'));
    if (req.method === 'GET' && pathname === '/jobs/list') return handleListJobs(res, String(url.searchParams.get('deviceId') || '').trim());
    if (req.method === 'POST' && pathname === '/jobs/delete') return handleDeleteJob(res, body);

    // --- Billing ---
    if (req.method === 'POST' && pathname === '/billing/init') return handleBillingInit(res, body);
    if (req.method === 'GET' && pathname === '/billing/balance') return handleBalance(res, String(url.searchParams.get('deviceId') || '').trim());

    // --- Config ---
    if (req.method === 'GET' && pathname === '/config') {
      return sendJson(res, 200, loadConfig());
    }

    // --- Checkin ---
    if (req.method === 'POST' && pathname === '/checkin') return handleCheckin(res, body);
    if (req.method === 'POST' && pathname === '/checkin/status') return handleCheckinStatus(res, body);

    // --- Worker (internal) ---
    if (req.method === 'GET' && pathname === '/worker/poll') return handleWorkerPoll(req, res);
    if (req.method === 'GET' && pathname === '/worker/poll-batch') return handleWorkerPollBatch(req, res);
    if (req.method === 'POST' && pathname === '/worker/progress') return handleWorkerProgress(req, res, body);
    if (req.method === 'POST' && pathname === '/worker/complete') return handleWorkerComplete(req, res, body);
    if (req.method === 'POST' && pathname === '/worker/fail') return handleWorkerFail(req, res, body);
  } catch (e) {
    return sendJson(res, 500, { error: 'InternalError', message: String(e?.message || e) });
  }

  sendJson(res, 404, { error: 'NotFound' });
});

const port = process.env.PORT ? Number(process.env.PORT) : 9001;
server.listen(port, () => {
  console.log(`AirTranslate server listening on port ${port}`);
  console.log(`Data directory: ${DATA_DIR}`);
});
