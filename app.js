'use strict';

// =========================================================================
// AirTranslate Server (v6 - all-in-one, no Worker)
// - 积分/任务/进度: 本地文件系统 ./data/
// - COS: 仅用于 presign URL (EPUB 上传/下载/术语表)
// - 翻译引擎 (三引擎独立并发，互不干扰):
//   · 机器翻译 (10并发): Azure Edge → MyMemory → Google, 段落级
//   · AI翻译·在线 (3并发): 腾讯混元翻译 API, 章节级逐段, 支持术语库 GlossaryIDs
//   · AI翻译·个人 (1并发): 通过 frp 内网穿透访问本地 vLLM, 章节级分块
// - 端口 9001 (避免和 AirRead 的 9000 冲突)
// =========================================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const cheerio = require('cheerio');

// ---------------------------------------------------------------------------
// 加载 .env 文件 (依赖: cheerio 用于 EPUB HTML 解析)
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
// 信号量 (独立并发控制)
// ---------------------------------------------------------------------------

class Semaphore {
  constructor(max) {
    this._max = max;
    this._current = 0;
    this._queue = [];
  }
  acquire() {
    if (this._current < this._max) {
      this._current++;
      return Promise.resolve();
    }
    return new Promise(resolve => this._queue.push(resolve));
  }
  release() {
    this._current--;
    if (this._queue.length > 0) {
      this._current++;
      this._queue.shift()();
    }
  }
  get running() { return this._current; }
  get waiting() { return this._queue.length; }
}

const SEM_MACHINE   = new Semaphore(10);
const SEM_AI_ONLINE = new Semaphore(3);
const SEM_AI_LOCAL  = new Semaphore(1);

function getSemaphore(engineType) {
  if (engineType === 'AI_ONLINE') return SEM_AI_ONLINE;
  if (engineType === 'AI') return SEM_AI_LOCAL;
  return SEM_MACHINE;
}

// ---------------------------------------------------------------------------
// 数据目录初始化
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, 'data');
const DIRS = {
  points:   path.join(DATA_DIR, 'points'),
  jobs:     path.join(DATA_DIR, 'jobs'),
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
  if (e === 'AI_ONLINE') return 'AI_ONLINE';
  if (e === 'AI' || e === 'HY') return 'AI';
  return 'MACHINE';
}

function isAiEngine(engineType) {
  return engineType === 'AI' || engineType === 'AI_ONLINE';
}

// ---------------------------------------------------------------------------
// Tencent Cloud v3 签名 (用于短信/混元 API)
// ---------------------------------------------------------------------------

function sha256Hex(msg) {
  return crypto.createHash('sha256').update(msg, 'utf8').digest('hex');
}

function hmacSha256(key, msg, encoding) {
  return crypto.createHmac('sha256', key).update(msg, 'utf8').digest(encoding);
}

function formatDateUTC(tsSeconds) {
  const d = new Date(tsSeconds * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function buildTc3Auth({ secretId, secretKey, service, host, action, version, region, timestampSeconds, payloadJson }) {
  const algorithm = 'TC3-HMAC-SHA256';
  const date = formatDateUTC(timestampSeconds);
  const canonicalUri = '/';
  const canonicalQueryString = '';
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
  const signedHeaders = 'content-type;host';
  const hashedRequestPayload = sha256Hex(payloadJson);
  const canonicalRequest = ['POST', canonicalUri, canonicalQueryString, canonicalHeaders, signedHeaders, hashedRequestPayload].join('\n');
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [algorithm, String(timestampSeconds), credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const secretDate = hmacSha256(`TC3${secretKey}`, date);
  const secretService = hmacSha256(secretDate, service);
  const secretSigning = hmacSha256(secretService, 'tc3_request');
  const signature = hmacSha256(secretSigning, stringToSign, 'hex');
  const authorization = `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    Host: host,
    'X-TC-Action': action,
    'X-TC-Version': version,
    'X-TC-Timestamp': String(timestampSeconds),
    Authorization: authorization,
  };
  if (region && String(region).trim()) headers['X-TC-Region'] = String(region).trim();
  return headers;
}

// ---------------------------------------------------------------------------
// 用户认证存储目录
// ---------------------------------------------------------------------------

const AUTH_DIRS = {
  users:  path.join(DATA_DIR, 'users'),
  sms:    path.join(DATA_DIR, 'sms'),
  tokens: path.join(DATA_DIR, 'tokens'),
};
for (const dir of Object.values(AUTH_DIRS)) {
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// 短信验证码
// ---------------------------------------------------------------------------

function _smsFile(phone) {
  const safe = String(phone).replace(/[^0-9]/g, '');
  return path.join(AUTH_DIRS.sms, `${safe}.json`);
}

function _generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendSmsCode(phone) {
  const safe = String(phone).replace(/[^0-9]/g, '');
  if (safe.length !== 11) return { error: 'InvalidPhone' };

  const file = _smsFile(safe);
  let smsData = null;
  try { if (fs.existsSync(file)) smsData = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) {}

  const now = Date.now();
  const today = new Date().toISOString().substring(0, 10);

  if (smsData) {
    if (smsData.lastSentAt && (now - smsData.lastSentAt) < 60000) {
      return { error: 'TooFrequent', message: '发送太频繁，请60秒后重试' };
    }
    if (smsData.dailyDate === today && (smsData.dailyCount || 0) >= 10) {
      return { error: 'DailyLimit', message: '今日验证码发送次数已达上限' };
    }
  }

  const code = _generateCode();
  const expireAt = now + 5 * 60 * 1000;

  const smsAppId = (process.env.SMS_APP_ID || '').trim();
  const smsSign = (process.env.SMS_SIGN || '').trim();
  const smsTemplateId = (process.env.SMS_TEMPLATE_ID || '').trim();
  const secretId = (process.env.TENCENT_SECRET_ID || '').trim();
  const secretKey = (process.env.TENCENT_SECRET_KEY || '').trim();

  if (!smsAppId || !smsSign || !smsTemplateId || !secretId || !secretKey) {
    console.error('[SMS] Missing SMS config env vars');
    return { error: 'SmsConfigError', message: '短信服务未配置' };
  }

  // 模板参数：1=仅验证码{1}，2=验证码{1}+有效期分钟数{2}；需与腾讯云正文模板占位符一致
  const paramCount = parseInt((process.env.SMS_TEMPLATE_PARAM_COUNT || '1').trim(), 10) || 1;
  const templateParamSet = paramCount >= 2 ? [code, '5'] : [code];

  const smsPayload = {
    SmsSdkAppId: smsAppId,
    SignName: smsSign,
    TemplateId: smsTemplateId,
    TemplateParamSet: templateParamSet,
    PhoneNumberSet: [`+86${safe}`],
  };
  const smsPayloadJson = JSON.stringify(smsPayload);
  const ts = Math.floor(now / 1000);
  const smsHeaders = buildTc3Auth({
    secretId, secretKey,
    service: 'sms', host: 'sms.tencentcloudapi.com',
    action: 'SendSms', version: '2021-01-11',
    region: 'ap-guangzhou', timestampSeconds: ts,
    payloadJson: smsPayloadJson,
  });

  try {
    const smsResp = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'sms.tencentcloudapi.com',
        method: 'POST', path: '/',
        headers: smsHeaders,
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
      req.write(smsPayloadJson);
      req.end();
    });

    const resp = smsResp.Response || smsResp;
    if (resp.Error) {
      console.error('[SMS] API error:', resp.Error);
      return { error: 'SmsSendFailed', message: resp.Error.Message || '短信发送失败' };
    }
    const sendStatus = resp.SendStatusSet && resp.SendStatusSet[0];
    if (sendStatus && sendStatus.Code !== 'Ok') {
      console.error('[SMS] Send status:', sendStatus);
      return { error: 'SmsSendFailed', message: sendStatus.Message || '短信发送失败' };
    }
  } catch (e) {
    console.error('[SMS] Request error:', e.message);
    return { error: 'SmsSendFailed', message: '短信发送失败' };
  }

  const dailyCount = (smsData && smsData.dailyDate === today) ? (smsData.dailyCount || 0) + 1 : 1;
  fs.writeFileSync(file, JSON.stringify({ code, expireAt, lastSentAt: now, dailyDate: today, dailyCount }, null, 2), 'utf-8');
  console.log(`[SMS] Sent code to ${safe.substring(0, 3)}****${safe.substring(7)}`);
  return { success: true };
}

function verifySmsCode(phone, code) {
  const safe = String(phone).replace(/[^0-9]/g, '');
  const file = _smsFile(safe);
  if (!fs.existsSync(file)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (Date.now() > data.expireAt) return false;
    if (data.code !== String(code).trim()) return false;
    fs.unlinkSync(file);
    return true;
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 用户管理
// ---------------------------------------------------------------------------

function _userFile(phone) {
  const safe = String(phone).replace(/[^0-9]/g, '');
  return path.join(AUTH_DIRS.users, `${safe}.json`);
}

function _tokenFile(token) {
  const safe = String(token).replace(/[^a-zA-Z0-9_\-]/g, '');
  return path.join(AUTH_DIRS.tokens, `${safe}.json`);
}

function _generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function findOrCreateUser(phone) {
  const safe = String(phone).replace(/[^0-9]/g, '');
  const file = _userFile(safe);
  const now = new Date().toISOString();

  if (fs.existsSync(file)) {
    const user = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (user.token) {
      const oldTf = _tokenFile(user.token);
      try { if (fs.existsSync(oldTf)) fs.unlinkSync(oldTf); } catch (_) {}
    }
    const token = _generateToken();
    user.token = token;
    user.lastLoginAt = now;
    user.loginCount = (user.loginCount || 0) + 1;
    fs.writeFileSync(file, JSON.stringify(user, null, 2), 'utf-8');
    fs.writeFileSync(_tokenFile(token), JSON.stringify({ userId: user.userId, phone: safe }), 'utf-8');
    return user;
  }

  const userId = 'u_' + crypto.randomBytes(8).toString('hex');
  const token = _generateToken();
  const user = { userId, phone: safe, token, createdAt: now, lastLoginAt: now, loginCount: 1, devices: [] };
  fs.writeFileSync(file, JSON.stringify(user, null, 2), 'utf-8');
  fs.writeFileSync(_tokenFile(token), JSON.stringify({ userId, phone: safe }), 'utf-8');
  console.log(`[Auth] New user: ${userId} phone=${safe.substring(0, 3)}****${safe.substring(7)}`);
  return user;
}

function getUserByToken(token) {
  if (!token) return null;
  const tf = _tokenFile(token);
  if (!fs.existsSync(tf)) return null;
  try {
    const mapping = JSON.parse(fs.readFileSync(tf, 'utf-8'));
    const uf = _userFile(mapping.phone);
    if (!fs.existsSync(uf)) return null;
    return JSON.parse(fs.readFileSync(uf, 'utf-8'));
  } catch (_) {
    return null;
  }
}

function revokeToken(token) {
  if (!token) return;
  const tf = _tokenFile(token);
  try { if (fs.existsSync(tf)) fs.unlinkSync(tf); } catch (_) {}
}

/** 从请求中提取 userId: 优先 token → fallback deviceId header */
function getUserIdFromReq(req) {
  const token = String(req.headers['x-auth-token'] || '').trim();
  if (token) {
    const user = getUserByToken(token);
    if (user) return user.userId;
  }
  return null;
}

/** 获取请求中的有效身份: userId (from token) 或 deviceId (from header/body) */
function getEffectiveId(req, body) {
  const userId = getUserIdFromReq(req);
  if (userId) return userId;
  return String(body?.deviceId || req.headers['x-device-id'] || '').trim();
}

// ---------------------------------------------------------------------------
// API Key 验证 (App 请求)
// ---------------------------------------------------------------------------

function verifyApiKey(req) {
  const key = (process.env.API_KEY || '').trim();
  if (!key) return true;
  const header = (req.headers['x-api-key'] || '').trim();
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
  billing_unit_chars: 100,      // 个人AI: 1积分/100字
  billing_unit_cost: 1,
  online_ai_billing_multiplier: 100,  // 在线AI: 1积分/字 (100积分/100字)
  local_ai_enabled: true,
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
// vLLM 健康检查 (定时 ping 本地 AI API 是否可达)
// ---------------------------------------------------------------------------

let _vllmAvailable = false;
const VLLM_HEALTH_INTERVAL_MS = 30_000;

function isLocalAiAvailable() {
  const cfg = loadConfig();
  if (!cfg.local_ai_enabled) return false;
  return _vllmAvailable;
}

function checkVllmHealth() {
  const vllmUrl = (process.env.VLLM_API_URL || '').trim();
  if (!vllmUrl || !loadConfig().local_ai_enabled) {
    _vllmAvailable = false;
    return;
  }
  const url = `${vllmUrl}/v1/models`;
  const mod = url.startsWith('https') ? https : http;
  const req = mod.get(url, { timeout: 5000 }, (resp) => {
    let data = '';
    resp.on('data', c => data += c);
    resp.on('end', () => {
      const wasAvailable = _vllmAvailable;
      _vllmAvailable = resp.statusCode >= 200 && resp.statusCode < 300;
      if (_vllmAvailable && !wasAvailable) console.log('[vllm] Local AI is online: %s', vllmUrl);
      if (!_vllmAvailable && wasAvailable) console.log('[vllm] Local AI went offline');
    });
  });
  req.on('error', () => {
    if (_vllmAvailable) console.log('[vllm] Local AI went offline (unreachable)');
    _vllmAvailable = false;
  });
}

checkVllmHealth();
setInterval(checkVllmHealth, VLLM_HEALTH_INTERVAL_MS);

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

function ensureInitialGrant(deviceId, isUserId) {
  const data = _readPointsData(deviceId);
  const grantAmount = Number(loadConfig().initial_grant_points) || 500000;
  if (!data.initialGranted) {
    if (isUserId) {
      data.balance = (Number(data.balance) || 0) + grantAmount;
      data.initialGranted = true;
      _writePointsData(deviceId, data);
      console.log(`[points] initial grant ${grantAmount} to userId=${deviceId}`);
      return { balance: Number(data.balance), initialGrantedThisTime: true };
    } else {
      _writePointsData(deviceId, data);
      console.log(`[points] new anonymous device ${deviceId}, balance=${data.balance}`);
      return { balance: Number(data.balance) || 0, initialGrantedThisTime: false };
    }
  }
  return { balance: Number(data.balance) || 0, initialGrantedThisTime: false };
}

function doCheckin(deviceId) {
  const today = new Date().toISOString().substring(0, 10);
  const data = _readPointsData(deviceId);

  const lastCheckin = data.lastCheckinDate || '';
  if (lastCheckin === today) {
    return { points: 0, alreadyDone: true, balance: Number(data.balance) || 0 };
  }

  const cfg = loadConfig();
  data.balance = (Number(data.balance) || 0) + cfg.checkin_points;
  data.lastCheckinDate = today;
  _writePointsData(deviceId, data);
  console.log(`[checkin] ${deviceId} +${cfg.checkin_points}`);
  return { points: cfg.checkin_points, alreadyDone: false, balance: data.balance };
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
// API: POST /jobs/create
// ---------------------------------------------------------------------------

function handleCreateJob(req, res, body) {
  const { bucket, region } = getCosConfig();
  if (!bucket || !region) return sendJson(res, 500, { error: 'ServerMisconfiguration', message: 'COS not configured' });

  const engineType = normalizeEngineType(body.engineType || body.engine);
  const output = normalizeOutput(body.output);
  const rawDeviceId = String(body.deviceId || body.device_id || '').trim();
  const effectiveId = getEffectiveId(req, body);
  const sourceLang = String(body.sourceLang || body.source_lang || 'auto').trim() || 'auto';
  const targetLang = String(body.targetLang || body.target_lang || '').trim();
  const sourceFileName = String(body.sourceFileName || body.source_file_name || '').trim();
  const charCount = Number(body.charCount || 0) || 0;
  const useGlossary = Boolean(body.useGlossary);

  if (!targetLang) return sendJson(res, 400, { error: 'BadRequest', message: 'targetLang required' });
  if (!sourceFileName) return sendJson(res, 400, { error: 'BadRequest', message: 'sourceFileName required' });
  if (!effectiveId) return sendJson(res, 400, { error: 'BadRequest', message: 'deviceId required' });

  // AI翻译: 预扣积分 (在线按字计 1积分/字，个人按百字计 1积分/100字)
  let pointsDeducted = 0;
  if (isAiEngine(engineType) && charCount > 0) {
    const cfg = loadConfig();
    const { billing_unit_chars, billing_unit_cost, online_ai_billing_multiplier } = cfg;
    if (engineType === 'AI_ONLINE') {
      // 在线: 1积分/字，不按百取整
      pointsDeducted = Math.ceil((charCount * billing_unit_cost * (online_ai_billing_multiplier || 100)) / (billing_unit_chars || 100));
    } else {
      // 个人: 1积分/100字，按百取整
      pointsDeducted = Math.ceil(charCount / (billing_unit_chars || 100)) * billing_unit_cost;
    }
    const balance = readPointsBalance(effectiveId);
    if (balance < pointsDeducted) {
      return sendJson(res, 409, { error: 'POINTS_INSUFFICIENT', need: pointsDeducted, balance });
    }
    writePointsBalance(effectiveId, balance - pointsDeducted);
  }

  const jobId = crypto.randomBytes(16).toString('hex');
  const nowIso = new Date().toISOString();
  const { presignSeconds } = getCosConfig();

  const spec = {
    jobId, engineType, output, deviceId: rawDeviceId, ownerId: effectiveId,
    sourceLang, targetLang, sourceFileName, charCount,
    useGlossary,
    pointsDeducted, createdAt: nowIso,
  };
  const progress = { jobId, state: 'CREATED', percent: 0, engineType, output, updatedAt: nowIso };

  writeJobSpec(jobId, spec);
  writeProgress(jobId, progress);

  // 生成 COS presign URL (EPUB 上传)
  const sourceKey = buildCosKey(`${jobId}/source.epub`);
  const uploadUrl = cosPresignUrl({ method: 'PUT', key: sourceKey, expiresSeconds: presignSeconds, headers: { 'content-type': 'application/epub+zip' } });

  // 术语表上传 URL (AI/AI_ONLINE + useGlossary)
  let glossaryUpload = null;
  if (isAiEngine(engineType) && useGlossary) {
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

  progress.state = 'UPLOADED';
  progress.updatedAt = new Date().toISOString();
  writeProgress(jobId, progress);

  // 所有翻译任务由服务端直接异步处理
  processTranslationJob(jobId).catch(e => {
    console.error(`[translate][${jobId.substring(0, 8)}] Unhandled error:`, e.message);
  });

  return sendJson(res, 200, { ok: true, handler: 'server' });
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
    if (job && job.pointsDeducted > 0) {
      const refundTo = job.ownerId || job.deviceId;
      if (refundTo) {
        const cur = readPointsBalance(refundTo);
        writePointsBalance(refundTo, cur + job.pointsDeducted);
        progress._refunded = true;
        progress.refundedPoints = job.pointsDeducted;
        writeProgress(jobId, progress);
      }
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

function handleListJobs(req, res, deviceId) {
  // 优先用登录 userId, 同时也匹配 deviceId
  const userId = getUserIdFromReq(req);
  if (!deviceId && !userId) return sendJson(res, 400, { error: 'BadRequest', message: 'deviceId required' });

  const jobs = [];
  try {
    const dirs = fs.readdirSync(DIRS.jobs);
    for (const jobId of dirs) {
      const job = readJobSpec(jobId);
      if (!job) continue;
      // 匹配: ownerId == userId 或 deviceId == deviceId 或旧任务 deviceId == deviceId
      const match = (userId && (job.ownerId === userId || job.deviceId === userId))
                 || (deviceId && (job.deviceId === deviceId || job.ownerId === deviceId));
      if (match) {
        const progress = readProgress(jobId) || {};
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

  // 退还积分（仅未开始翻译的 AI 任务：CREATED / READY / UPLOADED）
  let refunded = 0;
  const canRefund = (state === 'CREATED' || state === 'READY' || state === 'UPLOADED');
  const refundTo = spec.ownerId || spec.deviceId;
  if (canRefund && spec.pointsDeducted > 0 && refundTo && !progress._refunded) {
    const cur = readPointsBalance(refundTo);
    writePointsBalance(refundTo, cur + spec.pointsDeducted);
    refunded = spec.pointsDeducted;
    console.log(`[delete] refund ${refunded} to ${refundTo} for job ${jobId}`);
  }

  // 删除任务目录
  const jobDir = getJobDir(jobId);
  try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (_) {}

  return sendJson(res, 200, { ok: true, refundedPoints: refunded });
}

// ---------------------------------------------------------------------------
// API: GET /billing/balance
// ---------------------------------------------------------------------------

function handleBalance(req, res, deviceId) {
  const id = getUserIdFromReq(req) || deviceId;
  if (!id) return sendJson(res, 400, { error: 'BadRequest', message: 'deviceId required' });
  const balance = readPointsBalance(id);
  return sendJson(res, 200, { deviceId: id, balance });
}

// ---------------------------------------------------------------------------
// API: POST /billing/init  — 初始化积分（首次赠送）+ 返回余额
// ---------------------------------------------------------------------------

function handleBillingInit(req, res, body) {
  const userId = getUserIdFromReq(req);
  const id = userId || getEffectiveId(req, body);
  if (!id) return sendJson(res, 400, { error: 'BadRequest', message: 'deviceId required' });
  const { balance } = ensureInitialGrant(id, !!userId);
  return sendJson(res, 200, { deviceId: id, balance });
}

// ---------------------------------------------------------------------------
// API: POST /checkin  — 每日签到
// ---------------------------------------------------------------------------

function handleCheckin(req, res, body) {
  const id = getEffectiveId(req, body);
  if (!id) return sendJson(res, 400, { error: 'BadRequest', message: 'deviceId required' });
  const result = doCheckin(id);
  return sendJson(res, 200, result);
}

// ---------------------------------------------------------------------------
// API: POST /checkin/status  — 查询签到状态
// ---------------------------------------------------------------------------

function handleCheckinStatus(req, res, body) {
  const id = getEffectiveId(req, body);
  if (!id) return sendJson(res, 400, { error: 'BadRequest', message: 'deviceId required' });
  const data = _readPointsData(id);
  const today = new Date().toISOString().substring(0, 10);
  const done = data.lastCheckinDate === today;
  return sendJson(res, 200, { checkedInToday: done });
}

// ---------------------------------------------------------------------------
// 翻译引擎: 机器翻译 (Azure Edge → MyMemory → Google, 链式退避)
// ---------------------------------------------------------------------------

function translateMachine(texts, srcLang, tgtLang) {
  const engines = [
    { name: 'azure', fn: translateAzure },
    { name: 'mymemory', fn: translateMyMemory },
    { name: 'google', fn: translateGoogle },
  ];
  return (async () => {
    let lastErr;
    for (const { name, fn } of engines) {
      try {
        const result = await fn(texts, srcLang, tgtLang);
        console.log(`[machine] ${name} OK (${texts.length} texts)`);
        return result;
      } catch (e) {
        lastErr = e;
        console.log(`[machine] ${name} failed: ${e.message}, trying next...`);
      }
    }
    throw new Error(`All machine engines failed: ${lastErr?.message}`);
  })();
}

const _azureLangMap = {
  en:'en', fr:'fr', de:'de', es:'es', ja:'ja', it:'it', ko:'ko', pt:'pt-pt',
  ar:'ar', nl:'nl', ru:'ru', th:'th', vi:'vi', zh:'zh-Hans', 'zh-cn':'zh-Hans',
  'zh-tw':'zh-Hant', 'zh-hans':'zh-Hans', 'zh-hant':'zh-Hant',
};
let _azureToken = null, _azureTokenExpires = 0;

async function _getAzureToken() {
  if (_azureToken && Date.now() / 1000 < _azureTokenExpires) return _azureToken;
  return new Promise((resolve, reject) => {
    https.get('https://edge.microsoft.com/translate/auth', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => { _azureToken = data.trim(); _azureTokenExpires = Date.now() / 1000 + 480; resolve(_azureToken); });
    }).on('error', reject);
  });
}

async function translateAzure(texts, srcLang, tgtLang) {
  const token = await _getAzureToken();
  const azTgt = _azureLangMap[tgtLang.toLowerCase()] || tgtLang;
  const body = JSON.stringify(texts.map(t => ({ Text: t })));
  return new Promise((resolve, reject) => {
    const url = new URL(`https://api-edge.cognitive.microsofttranslator.com/translate?to=${encodeURIComponent(azTgt)}&api-version=3.0`);
    const req = https.request({ hostname: url.hostname, path: url.pathname + url.search, method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        if (resp.statusCode >= 400) return reject(new Error(`Azure ${resp.statusCode}: ${data.substring(0, 200)}`));
        try {
          const arr = JSON.parse(data);
          resolve(arr.map((item, i) => (item.translations && item.translations[0]) ? item.translations[0].text : texts[i]));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function translateMyMemory(texts, srcLang, tgtLang) {
  const results = [];
  for (const text of texts) {
    if (!text || !text.trim()) { results.push(text); continue; }
    const params = new URLSearchParams({ q: text, langpair: `${srcLang}|${tgtLang}` });
    const email = (process.env.MYMEMORY_EMAIL || '').trim();
    if (email) params.set('de', email);
    const resp = await new Promise((resolve, reject) => {
      https.get(`https://api.mymemory.translated.net/get?${params}`, { timeout: 15000 }, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
      }).on('error', reject);
    });
    const translated = resp?.responseData?.translatedText || '';
    if (!translated || translated.toUpperCase().includes('MYMEMORY WARNING')) throw new Error('MyMemory limit');
    results.push(translated);
  }
  return results;
}

async function translateGoogle(texts, srcLang, tgtLang) {
  const results = [];
  for (const text of texts) {
    if (!text || !text.trim()) { results.push(text); continue; }
    const body = `client=gtx&sl=${srcLang === 'auto' ? 'auto' : srcLang}&tl=${tgtLang}&dt=t&q=${encodeURIComponent(text)}`;
    const resp = await new Promise((resolve, reject) => {
      const req = https.request({ hostname: 'translate.googleapis.com', path: '/translate_a/single', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 }, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    let translated = '';
    if (resp && Array.isArray(resp) && resp[0]) {
      for (const seg of resp[0]) { if (Array.isArray(seg) && seg[0]) translated += seg[0]; }
    }
    results.push(translated || text);
  }
  return results;
}

// ---------------------------------------------------------------------------
// 翻译引擎: vLLM 本地 AI (通过 frp 穿透访问)
// ---------------------------------------------------------------------------

const VLLM_GEN_KWARGS = { top_k: 20, top_p: 0.6, temperature: 0.7, repetition_penalty: 1.05 };
const MAX_CHAPTER_PARAGRAPHS = 20;

function callVllmChat(prompt, maxTokens, opts = {}) {
  const vllmUrl = (process.env.VLLM_API_URL || '').trim().replace(/\/+$/, '');
  const modelName = (process.env.VLLM_MODEL_NAME || 'HY-MT1.5').trim();
  const logPrefix = opts.logPrefix || '[vllm]';
  if (!vllmUrl) return Promise.reject(new Error('VLLM_API_URL not configured'));

  const payload = JSON.stringify({
    model: modelName,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
    stream: false,
    ...VLLM_GEN_KWARGS,
  });

  const url = `${vllmUrl}/v1/chat/completions`;
  const mod = url.startsWith('https') ? https : http;
  const urlObj = new URL(url);
  console.log(`${logPrefix} POST ${url} promptLen=${prompt.length} maxTokens=${maxTokens}`);

  return new Promise((resolve, reject) => {
    const req = mod.request({
      hostname: urlObj.hostname, port: urlObj.port, path: urlObj.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 300000,
    }, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        if (resp.statusCode >= 400) {
          console.error(`${logPrefix} vLLM error ${resp.statusCode}: ${data.substring(0, 500)}`);
          return reject(new Error(`vLLM ${resp.statusCode}: ${data.substring(0, 300)}`));
        }
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.message?.content?.trim() || '';
          const usage = parsed.usage || {};
          console.log(`${logPrefix} OK contentLen=${content.length} inputTokens=${usage.prompt_tokens || '-'} outputTokens=${usage.completion_tokens || '-'}`);
          if (!content) console.warn(`${logPrefix} Empty response from vLLM`);
          resolve({ content, usage });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('vLLM request timeout')); });
    req.write(payload);
    req.end();
  });
}

function buildChapterPrompt(texts, srcLang, tgtLang, context, glossary) {
  const parts = [];
  // 本地 AI 提示词最多支持 10 条术语，过多会超出上下文
  if (glossary && Object.keys(glossary).length > 0) {
    const entries = Object.entries(glossary).slice(0, 10);
    parts.push('参考下面的翻译：\n' + entries.map(([k, v]) => `${k} 翻译成 ${v}`).join('\n'));
  }
  const cnLangs = new Set(['zh', 'zh-cn', 'zh-tw', 'zh-hans', 'zh-hant']);
  const isCn = cnLangs.has(srcLang.toLowerCase()) || cnLangs.has(tgtLang.toLowerCase());

  if (context) {
    parts.push(context);
    parts.push(isCn
      ? `参考上面的信息，把下面的文本翻译成${tgtLang}，注意不需要翻译上文，也不要额外解释。文本由${texts.length}个编号段落组成，请逐段翻译，每段翻译前保留对应的编号标记如[1] [2]等：`
      : `Based on the context above, translate the following text into ${tgtLang}. Do not translate the context. The text has ${texts.length} numbered paragraphs. Translate each paragraph and keep the number markers like [1] [2] etc.`
    );
  } else {
    parts.push(isCn
      ? `将以下文本翻译为${tgtLang}。文本由${texts.length}个编号段落组成。请逐段翻译，每段翻译前保留对应的编号标记如[1] [2]等，只输出翻译结果，不要额外解释：`
      : `Translate the following text into ${tgtLang}. The text has ${texts.length} numbered paragraphs. Translate each paragraph, keep the number markers like [1] [2] etc, and output only the translation without additional explanation.`
    );
  }
  parts.push(texts.map((t, i) => `[${i + 1}] ${t}`).join('\n\n'));
  return parts.join('\n\n');
}

function parseNumberedOutput(raw, expectedCount) {
  const patterns = [
    /\[(\d+)\]\s*/g,
    /\((\d+)\)\s*/g,
    /（(\d+)）\s*/g,
    /^(\d+)[.、:：)\]]\s*/gm,
  ];
  let bestResult = {}, bestMatched = 0;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    const matches = [...raw.matchAll(pattern)];
    if (!matches.length) continue;
    const result = {};
    for (let mi = 0; mi < matches.length; mi++) {
      const num = parseInt(matches[mi][1], 10);
      const start = matches[mi].index + matches[mi][0].length;
      const end = mi + 1 < matches.length ? matches[mi + 1].index : raw.length;
      const text = raw.substring(start, end).trim();
      if (num >= 1 && num <= expectedCount && text) result[num] = text;
    }
    if (Object.keys(result).length > bestMatched) {
      bestMatched = Object.keys(result).length;
      bestResult = result;
    }
  }
  if (Object.keys(bestResult).length > 0) return bestResult;

  for (const sep of ['\n\n', '\n']) {
    const parts = raw.split(sep).map(p => p.trim()).filter(Boolean);
    if (parts.length >= expectedCount * 0.5) {
      const result = {};
      parts.forEach((p, i) => { if (i < expectedCount) result[i + 1] = p; });
      return result;
    }
  }
  return {};
}

async function translateVllmChapter(texts, srcLang, tgtLang, context, glossary) {
  if (!texts.length) return [];
  const nonEmpty = [];
  texts.forEach((t, i) => { if (t && t.trim()) nonEmpty.push({ i, t }); });
  if (!nonEmpty.length) {
    console.log('[vllm] Chapter has no translatable segments, returning original');
    return [...texts];
  }
  const maxModelLen = parseInt(process.env.VLLM_MAX_MODEL_LEN || '8192', 10);
  const maxChapterChars = parseInt(process.env.VLLM_MAX_CHAPTER_INPUT_CHARS || String(Math.floor(maxModelLen / 3 * 1.5 * 2)), 10);
  const maxOutputTokens = Math.min(parseInt(process.env.VLLM_MAX_OUTPUT_TOKENS || '4096', 10), Math.floor(maxModelLen / 2));

  // Split into chunks by paragraph count + char count
  const chunks = [];
  let curChunk = [], curLen = 0;
  for (const item of nonEmpty) {
    if (curChunk.length && (curChunk.length >= MAX_CHAPTER_PARAGRAPHS || curLen + item.t.length > maxChapterChars)) {
      chunks.push(curChunk);
      curChunk = []; curLen = 0;
    }
    curChunk.push(item);
    curLen += item.t.length;
  }
  if (curChunk.length) chunks.push(curChunk);
  console.log(`[vllm] translateVllmChapter: ${texts.length} segments, ${nonEmpty.length} non-empty, ${chunks.length} chunks`);

  const results = [...texts];
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const chunkTexts = chunk.map(item => item.t);
    const totalChars = chunkTexts.reduce((s, t) => s + t.length, 0);
    const prompt = buildChapterPrompt(chunkTexts, srcLang, tgtLang, context, glossary);
    const maxNew = Math.min(Math.max(totalChars * 4, 256), maxOutputTokens);

    try {
      const { content: rawResult } = await callVllmChat(prompt, maxNew, { logPrefix: `[vllm] Chunk ${ci + 1}/${chunks.length}` });
      const map = parseNumberedOutput(rawResult, chunkTexts.length);
      const matchedCount = Object.keys(map).length;
      if (matchedCount < chunkTexts.length) {
        console.warn(`[vllm] Chunk ${ci + 1}/${chunks.length}: parsed ${matchedCount}/${chunkTexts.length} segments, raw length=${(rawResult || '').length}`);
      }
      for (let j = 0; j < chunk.length; j++) {
        const paraNum = j + 1;
        if (map[paraNum] && map[paraNum].trim()) {
          let result = map[paraNum].trim();
          const noteIdx = result.indexOf('（注');
          if (noteIdx !== -1) result = result.substring(0, noteIdx).trim();
          results[chunk[j].i] = result;
        }
      }
      // 未匹配的段落逐段补翻（避免出现无译文）
      const unmatched = chunk.filter((_, j) => !map[j + 1] || !map[j + 1].trim());
      if (unmatched.length > 0) {
        console.log(`[vllm] Chunk ${ci + 1}: ${unmatched.length} unmatched, translating individually`);
        for (const item of unmatched) {
          try {
            const singlePrompt = buildChapterPrompt([item.t], srcLang, tgtLang, context, glossary);
            const { content: singleRaw } = await callVllmChat(singlePrompt, Math.min(item.t.length * 4, 512), { logPrefix: `[vllm] Chunk ${ci + 1} single` });
            const singleMap = parseNumberedOutput(singleRaw, 1);
            if (singleMap[1] && singleMap[1].trim()) {
              let r = singleMap[1].trim();
              const ni = r.indexOf('（注');
              if (ni !== -1) r = r.substring(0, ni).trim();
              results[item.i] = r;
            }
          } catch (e) { console.warn(`[vllm] Single fallback failed for segment: ${e.message}`); }
        }
      }
    } catch (e) {
      console.error(`[vllm] Chunk ${ci + 1}/${chunks.length} failed: ${e.message}, falling back to per-paragraph`);
      for (const item of chunk) {
        try {
          const singlePrompt = buildChapterPrompt([item.t], srcLang, tgtLang, context, glossary);
          const { content: singleRaw } = await callVllmChat(singlePrompt, Math.min(item.t.length * 4, 512), { logPrefix: `[vllm] Chunk ${ci + 1} fallback` });
          const singleMap = parseNumberedOutput(singleRaw, 1);
          if (singleMap[1] && singleMap[1].trim()) {
            let r = singleMap[1].trim();
            const ni = r.indexOf('（注');
            if (ni !== -1) r = r.substring(0, ni).trim();
            results[item.i] = r;
          }
        } catch (err) { console.warn(`[vllm] Fallback failed: ${err.message}`); }
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// 翻译引擎: 在线 AI (腾讯混元翻译 API)
// ---------------------------------------------------------------------------

function callHunyuanTranslation(text, srcLang, tgtLang, glossaryIds) {
  return new Promise((resolve, reject) => {
    const secretId = (process.env.TENCENT_SECRET_ID || '').trim();
    const secretKey = (process.env.TENCENT_SECRET_KEY || '').trim();
    if (!secretId || !secretKey) return reject(new Error('TENCENT_SECRET_ID/KEY not configured'));

    const host = 'hunyuan.tencentcloudapi.com';
    const action = 'ChatTranslations';
    const version = '2023-09-01';
    const region = (process.env.HY_REGION || 'ap-guangzhou').trim();
    const model = (process.env.HY_TRANSLATION_MODEL || 'hunyuan-translation').trim();

    const hySrc = srcLang !== 'auto' ? toHunyuanLang(srcLang) : undefined;
    const hyTgt = toHunyuanLang(tgtLang);

    const payload = { Model: model, Stream: false, Text: text };
    if (hySrc) payload.Source = hySrc;
    if (hyTgt) payload.Target = hyTgt;
    if (glossaryIds && glossaryIds.length > 0) payload.GlossaryIDs = glossaryIds.slice(0, 5);
    const payloadJson = JSON.stringify(payload);

    const ts = Math.floor(Date.now() / 1000);
    const headers = buildTc3Auth({
      secretId, secretKey, service: 'hunyuan', host,
      action, version, region, timestampSeconds: ts, payloadJson,
    });

    const reqObj = https.request({
      hostname: host, method: 'POST', path: '/', headers,
    }, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const response = parsed.Response || parsed;
          if (response.Error) return reject(new Error(`${response.Error.Code}: ${response.Error.Message}`));
          const choices = response.Choices || [];
          if (choices.length > 0) {
            const msg = choices[0].Message || choices[0].Delta || {};
            const content = msg.Content || '';
            if (content) return resolve(content);
          }
          reject(new Error('Empty response from Hunyuan'));
        } catch (e) { reject(e); }
      });
    });
    reqObj.on('error', reject);
    reqObj.write(payloadJson);
    reqObj.end();
  });
}

const _activeJobs = new Set();

async function processTranslationJob(jobId) {
  if (_activeJobs.has(jobId)) return;
  _activeJobs.add(jobId);

  const tag = jobId.substring(0, 8);
  const spec = readJobSpec(jobId);
  if (!spec) { _activeJobs.delete(jobId); return; }

  const engineType = normalizeEngineType(spec.engineType);
  const engineLabel = { MACHINE: 'machine', AI: 'vllm', AI_ONLINE: 'online-ai' }[engineType] || 'machine';

  const sem = getSemaphore(engineType);
  console.log(`[${engineLabel}][${tag}] Waiting for semaphore (running=${sem.running}, waiting=${sem.waiting})...`);
  await sem.acquire();
  console.log(`[${engineLabel}][${tag}] Acquired semaphore slot`);

  let glossaryId = null; // 在线 AI 术语库 ID，翻译完成后需删除
  try {
    const cosUrls = (() => {
      const { presignSeconds } = getCosConfig();
      const sourceKey = buildCosKey(`${jobId}/source.epub`);
      const sourceDownloadUrl = cosPresignUrl({ method: 'GET', key: sourceKey, expiresSeconds: presignSeconds, headers: {} });
      const bilingualKey = buildCosKey(`${jobId}/bilingual.epub`);
      const bilingualUploadUrl = cosPresignUrl({ method: 'PUT', key: bilingualKey, expiresSeconds: presignSeconds, headers: { 'content-type': 'application/epub+zip' } });
      const translatedKey = buildCosKey(`${jobId}/translated.epub`);
      const translatedUploadUrl = cosPresignUrl({ method: 'PUT', key: translatedKey, expiresSeconds: presignSeconds, headers: { 'content-type': 'application/epub+zip' } });
      return { sourceDownloadUrl, bilingualUploadUrl, translatedUploadUrl };
    })();

    console.log(`[${engineLabel}][${tag}] Starting translation (engine=${engineType})`);
    if (engineType === 'AI') {
      const vllmUrl = (process.env.VLLM_API_URL || '').trim();
      console.log(`[vllm][${tag}] VLLM_API_URL=${vllmUrl || '(not set)'}`);
    }

    let progress = readProgress(jobId);
    if (!progress) return;
    progress.state = 'PARSING';
    progress.percent = 1;
    progress.updatedAt = new Date().toISOString();
    writeProgress(jobId, progress);

    const tmpDir = path.join(DATA_DIR, 'tmp', jobId);
    fs.mkdirSync(tmpDir, { recursive: true });
    const sourceEpub = path.join(tmpDir, 'source.epub');
    await downloadFile(cosUrls.sourceDownloadUrl, sourceEpub);

    const unpackDir = path.join(tmpDir, 'unpacked');
    await unzipEpub(sourceEpub, unpackDir);

    // 下载术语表 (AI个人 或 AI在线 + useGlossary)
    let glossary = null;
    if (isAiEngine(engineType) && spec.useGlossary) {
      const glossaryKey = buildCosKey(`${jobId}/glossary.json`);
      const { presignSeconds } = getCosConfig();
      const glossaryUrl = cosPresignUrl({ method: 'GET', key: glossaryKey, expiresSeconds: presignSeconds, headers: {} });
      try {
        const glossaryPath = path.join(tmpDir, 'glossary.json');
        await downloadFile(glossaryUrl, glossaryPath);
        const raw = fs.readFileSync(glossaryPath, 'utf-8');
        glossary = parseGlossaryContent(raw);
        console.log(`[${engineLabel}][${tag}] Loaded glossary with ${Object.keys(glossary).length} entries`);
        if (engineType === 'AI_ONLINE' && glossary && Object.keys(glossary).length > 0) {
          glossaryId = await glossaryToHunyuanGlossary(glossary, spec.sourceLang || 'auto', spec.targetLang || 'zh', tag);
          if (glossaryId) console.log(`[${engineLabel}][${tag}] Created Hunyuan glossary: ${glossaryId}`);
        }
      } catch (e) { console.log(`[${engineLabel}][${tag}] Glossary download failed: ${e.message}`); }
    }

    const htmlFiles = findHtmlFiles(unpackDir);
    if (htmlFiles.length === 0) {
      console.log(`[${engineLabel}][${tag}] No HTML files found`);
      progress.state = 'DONE'; progress.percent = 100;
      progress.updatedAt = new Date().toISOString();
      writeProgress(jobId, progress);
      cleanupDir(tmpDir);
      return;
    }

    console.log(`[${engineLabel}][${tag}] Found ${htmlFiles.length} HTML files`);
    progress.state = 'TRANSLATING'; progress.percent = 2;
    progress.chapterTotal = htmlFiles.length;
    progress.engineType = engineType;
    progress.updatedAt = new Date().toISOString();
    writeProgress(jobId, progress);

    const outputMode = spec.output || 'BILINGUAL';
    let contextPairs = [];

    for (let ci = 0; ci < htmlFiles.length; ci++) {
      const curProgress = readProgress(jobId);
      if (!curProgress || curProgress.state === 'CANCELED') {
        console.log(`[${engineLabel}][${tag}] Job cancelled, stopping`);
        cleanupDir(tmpDir);
        return;
      }

      const chapterNum = ci + 1;
      const htmlPath = htmlFiles[ci];

      const percentStart = Math.max(3, Math.min(98, Math.floor((ci / htmlFiles.length) * 100)));
      progress.state = 'TRANSLATING'; progress.percent = percentStart;
      progress.chapterIndex = chapterNum; progress.chapterTotal = htmlFiles.length;
      progress.updatedAt = new Date().toISOString();
      writeProgress(jobId, progress);

      console.log(`[${engineLabel}][${tag}] Chapter ${chapterNum}/${htmlFiles.length}: ${path.basename(htmlPath)}`);

      const { texts: originalTexts, writeBack } = extractAndPrepare(htmlPath);
      if (!originalTexts || originalTexts.length === 0) continue;

      let translatedTexts;
      if (engineType === 'AI') {
        const ctx = renderContext(contextPairs);
        translatedTexts = await translateVllmChapter(originalTexts, spec.sourceLang || 'auto', spec.targetLang || 'zh', ctx, glossary);
        updateContextPairs(contextPairs, originalTexts, translatedTexts);
      } else if (engineType === 'AI_ONLINE') {
        const onlineGlossaryIds = glossaryId ? [glossaryId] : null;
        translatedTexts = await translateOnlineChapter(originalTexts, spec.sourceLang || 'auto', spec.targetLang || 'zh', onlineGlossaryIds);
      } else {
        translatedTexts = await translateMachine(originalTexts, spec.sourceLang || 'auto', spec.targetLang || 'zh');
      }

      writeBack(translatedTexts, outputMode);
      if (engineType === 'AI') {
        const filled = translatedTexts.filter(t => t != null && String(t).trim()).length;
        console.log(`[vllm][${tag}] Chapter ${chapterNum} wrote ${filled}/${originalTexts.length} translations`);
      }

      const percentDone = Math.max(3, Math.min(99, Math.floor(((ci + 1) / htmlFiles.length) * 100)));
      progress.percent = percentDone; progress.chapterIndex = chapterNum;
      progress.updatedAt = new Date().toISOString();
      writeProgress(jobId, progress);
    }

    let totalHtmlBytes = 0;
    for (const hp of htmlFiles) {
      try { totalHtmlBytes += fs.statSync(hp).size; } catch (_) {}
    }
    console.log(`[${engineLabel}][${tag}] Repacking EPUB... (${htmlFiles.length} HTML files, ${totalHtmlBytes} bytes total)`);
    if (totalHtmlBytes < 100) console.warn(`[${engineLabel}][${tag}] WARNING: HTML content very small (${totalHtmlBytes} bytes), possible empty content`);
    progress.state = 'PACKAGING'; progress.percent = 99;
    progress.chapterIndex = htmlFiles.length;
    progress.updatedAt = new Date().toISOString();
    writeProgress(jobId, progress);

    const resultEpub = path.join(tmpDir, 'result.epub');
    await zipEpub(unpackDir, resultEpub);

    console.log(`[${engineLabel}][${tag}] Uploading result...`);
    progress.state = 'UPLOADING_RESULT';
    progress.updatedAt = new Date().toISOString();
    writeProgress(jobId, progress);

    // 在上传前重新生成 presign URL，避免翻译耗时过长导致 URL 过期（403 Request has expired）
    const { presignSeconds } = getCosConfig();
    const uploadCosKey = outputMode.toUpperCase() === 'BILINGUAL'
      ? buildCosKey(`${jobId}/bilingual.epub`)
      : buildCosKey(`${jobId}/translated.epub`);
    const uploadUrl = cosPresignUrl({ method: 'PUT', key: uploadCosKey, expiresSeconds: presignSeconds, headers: { 'content-type': 'application/epub+zip' } });
    await uploadFile(uploadUrl, resultEpub);

    progress.state = 'DONE'; progress.percent = 100;
    progress.updatedAt = new Date().toISOString();
    writeProgress(jobId, progress);
    console.log(`[${engineLabel}][${tag}] === DONE ===`);

    cleanupDir(tmpDir);
  } catch (e) {
    console.error(`[${engineLabel}][${tag}] FAILED:`, e.message || e);
    const progress = readProgress(jobId) || {};
    progress.state = 'FAILED';
    progress.error = { code: 'TRANSLATION_FAILED', message: String(e.message || e) };
    progress.updatedAt = new Date().toISOString();
    writeProgress(jobId, progress);
    if (spec && spec.pointsDeducted > 0) {
      const refundTo = spec.ownerId || spec.deviceId;
      if (refundTo) {
        const cur = readPointsBalance(refundTo);
        writePointsBalance(refundTo, cur + spec.pointsDeducted);
        progress._refunded = true;
        progress.refundedPoints = spec.pointsDeducted;
        writeProgress(jobId, progress);
      }
    }
    cleanupDir(path.join(DATA_DIR, 'tmp', jobId));
  } finally {
    if (glossaryId) {
      try {
        await deleteGlossary(glossaryId);
        console.log(`[${engineLabel}][${tag}] Deleted Hunyuan glossary: ${glossaryId}`);
      } catch (e) { console.warn(`[${engineLabel}][${tag}] Delete glossary failed: ${e.message}`); }
    }
    sem.release();
    _activeJobs.delete(jobId);
    console.log(`[${engineLabel}][${tag}] Released semaphore slot`);
  }
}

function renderContext(pairs) {
  if (!pairs.length) return null;
  return pairs.map(([src, tgt]) => `${src}\n${tgt}`).join('\n');
}

function updateContextPairs(pairs, originals, translations) {
  for (let i = 0; i < originals.length && i < translations.length; i++) {
    if (originals[i]?.trim() && translations[i]?.trim()) {
      pairs.push([originals[i].trim(), translations[i].trim()]);
    }
  }
  const maxModelLen = parseInt(process.env.VLLM_MAX_MODEL_LEN || '8192', 10);
  const budget = Math.floor(maxModelLen / 4 * 1.5);
  let total = 0, keepFrom = pairs.length;
  for (let i = pairs.length - 1; i >= 0; i--) {
    const pairLen = pairs[i][0].length + pairs[i][1].length + 2;
    if (total + pairLen > budget) break;
    total += pairLen;
    keepFrom = i;
  }
  if (keepFrom > 0) pairs.splice(0, keepFrom);
}

// 混元语言码映射 (CreateGlossary/ChatTranslations)
const HUNYUAN_LANG_MAP = {
  en: 'en', fr: 'fr', de: 'de', es: 'es', ja: 'ja', it: 'it', ko: 'ko',
  pt: 'pt', ar: 'ar', nl: 'nl', ru: 'ru', th: 'th', vi: 'vi',
  zh: 'zh', 'zh-cn': 'zh', 'zh-tw': 'zh-TR', 'zh-hans': 'zh', 'zh-hant': 'zh-TR',
};

function toHunyuanLang(lang) {
  if (!lang || lang === 'auto') return 'zh';
  return HUNYUAN_LANG_MAP[lang.toLowerCase()] || lang;
}

/** 通用混元 API 调用 */
function callHunyuanApi(action, payload) {
  return new Promise((resolve, reject) => {
    const secretId = (process.env.TENCENT_SECRET_ID || '').trim();
    const secretKey = (process.env.TENCENT_SECRET_KEY || '').trim();
    if (!secretId || !secretKey) return reject(new Error('TENCENT_SECRET_ID/KEY not configured'));
    const host = 'hunyuan.tencentcloudapi.com';
    const version = '2023-09-01';
    const region = (process.env.HY_REGION || 'ap-guangzhou').trim();
    const payloadJson = JSON.stringify(payload);
    const ts = Math.floor(Date.now() / 1000);
    const headers = buildTc3Auth({ secretId, secretKey, service: 'hunyuan', host, action, version, region, timestampSeconds: ts, payloadJson });
    const reqObj = https.request({
      hostname: host, method: 'POST', path: '/', headers,
    }, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const response = parsed.Response || parsed;
          if (response.Error) return reject(new Error(`${response.Error.Code}: ${response.Error.Message}`));
          resolve(response);
        } catch (e) { reject(e); }
      });
    });
    reqObj.on('error', reject);
    reqObj.write(payloadJson);
    reqObj.end();
  });
}

/** 创建术语库，返回 GlossaryId */
async function createGlossary(name, source, target) {
  const resp = await callHunyuanApi('CreateGlossary', {
    Name: name,
    Source: toHunyuanLang(source),
    Target: toHunyuanLang(target),
  });
  return resp.GlossaryId || resp.glossaryId;
}

/** 添加术语条目（单次最多100条） */
async function createGlossaryEntries(glossaryId, entries) {
  return callHunyuanApi('CreateGlossaryEntry', {
    GlossaryId: glossaryId,
    Entries: entries.map(([src, tgt]) => ({ SourceTerm: src, TargetTerm: tgt })),
  });
}

/** 删除术语库 */
async function deleteGlossary(glossaryId) {
  return callHunyuanApi('DeleteGlossary', { GlossaryId: glossaryId });
}

/** 解析术语表内容，支持 JSON 或配置文件格式（每行 key=value 或 key: value） */
function parseGlossaryContent(raw) {
  if (!raw || typeof raw !== 'string') return {};
  const s = raw.trim();
  if (!s) return {};
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        if (k && v != null) {
          const ks = String(k).trim();
          const vs = String(v).trim();
          if (ks && vs) out[ks] = vs;
        }
      }
      return out;
    }
  } catch (_) {}
  const out = {};
  for (const line of s.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    let k, v;
    if (l.includes('=')) {
      const idx = l.indexOf('=');
      k = l.substring(0, idx).trim();
      v = l.substring(idx + 1).trim();
    } else if (l.includes(':') && !l.startsWith('{')) {
      const idx = l.indexOf(':');
      k = l.substring(0, idx).trim();
      v = l.substring(idx + 1).trim();
    } else if (l.includes('\t')) {
      const parts = l.split('\t');
      if (parts.length >= 2) {
        k = parts[0].trim();
        v = parts.slice(1).join('\t').trim();
      }
    }
    if (k && v) out[k] = v;
  }
  return out;
}

/** 从 glossary 对象创建术语库，返回 glossaryId；无条目时返回 null */
async function glossaryToHunyuanGlossary(glossary, srcLang, tgtLang, jobTag) {
  if (!glossary || typeof glossary !== 'object') return null;
  const entries = Object.entries(glossary).filter(([k, v]) => k && v && String(k).trim() && String(v).trim());
  if (entries.length === 0) return null;
  const src = srcLang === 'auto' ? 'en' : srcLang;
  const tgt = tgtLang || 'zh';
  const glossaryId = await createGlossary(`at-${jobTag}`, src, tgt);
  for (let i = 0; i < entries.length; i += 100) {
    const batch = entries.slice(i, i + 100);
    await createGlossaryEntries(glossaryId, batch);
  }
  return glossaryId;
}

const ONLINE_MAX_PARAGRAPHS = 50;
const ONLINE_MAX_CHARS = 50000;

function buildOnlineNumberedText(texts) {
  return texts.map((t, i) => `[${i + 1}] ${t}`).join('\n\n');
}

async function translateOnlineChapter(texts, srcLang, tgtLang, glossaryIds) {
  if (!texts || texts.length === 0) return [];

  const nonEmpty = [];
  texts.forEach((t, i) => { if (t && t.trim()) nonEmpty.push({ i, t }); });
  if (!nonEmpty.length) return [...texts];

  const chunks = [];
  let curChunk = [], curLen = 0;
  for (const item of nonEmpty) {
    if (curChunk.length && (curChunk.length >= ONLINE_MAX_PARAGRAPHS || curLen + item.t.length > ONLINE_MAX_CHARS)) {
      chunks.push(curChunk);
      curChunk = []; curLen = 0;
    }
    curChunk.push(item);
    curLen += item.t.length;
  }
  if (curChunk.length) chunks.push(curChunk);

  const results = [...texts];
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const chunkTexts = chunk.map(item => item.t);
    const numberedText = buildOnlineNumberedText(chunkTexts);

    try {
      const rawResult = await callHunyuanTranslation(numberedText, srcLang, tgtLang, glossaryIds);
      const map = parseNumberedOutput(rawResult, chunkTexts.length);
      let matched = 0;
      for (let j = 0; j < chunk.length; j++) {
        const paraNum = j + 1;
        if (map[paraNum] && map[paraNum].trim()) {
          results[chunk[j].i] = map[paraNum].trim();
          matched++;
        }
      }
      console.log(`[online-ai] Chunk ${ci + 1}/${chunks.length}: ${chunkTexts.length} paragraphs, matched ${matched}`);

      // 未匹配的段落逐段补翻
      if (matched < chunkTexts.length) {
        const unmatched = chunk.filter((_, j) => !map[j + 1] || !map[j + 1].trim());
        if (unmatched.length > 0) {
          console.log(`[online-ai] Chunk ${ci + 1}: ${unmatched.length} unmatched, translating individually`);
          const fallbackPromises = unmatched.map(item =>
            callHunyuanTranslation(item.t, srcLang, tgtLang, glossaryIds).catch(() => item.t)
          );
          const fallbackResults = await Promise.all(fallbackPromises);
          unmatched.forEach((item, fi) => { results[item.i] = fallbackResults[fi]; });
        }
      }
    } catch (e) {
      console.error(`[online-ai] Chunk ${ci + 1}/${chunks.length} failed: ${e.message}, falling back to per-paragraph`);
      const promises = chunk.map(item =>
        callHunyuanTranslation(item.t, srcLang, tgtLang, glossaryIds).catch(() => item.t)
      );
      const fallbackResults = await Promise.all(promises);
      chunk.forEach((item, fi) => { results[item.i] = fallbackResults[fi]; });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// EPUB 处理辅助 (服务端内嵌)
// ---------------------------------------------------------------------------

function downloadFile(url, localPath) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 300000 }, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        return downloadFile(resp.headers.location, localPath).then(resolve).catch(reject);
      }
      if (resp.statusCode >= 400) return reject(new Error(`Download failed: ${resp.statusCode}`));
      const ws = fs.createWriteStream(localPath);
      resp.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
    });
    req.on('error', reject);
  });
}

function uploadFile(url, localPath) {
  return new Promise((resolve, reject) => {
    const fileSize = fs.statSync(localPath).size;
    const fileStream = fs.createReadStream(localPath);
    const mod = url.startsWith('https') ? https : http;
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: 'PUT',
      headers: { 'Content-Type': 'application/epub+zip', 'Content-Length': fileSize },
    };
    const req = mod.request(options, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        if (resp.statusCode >= 200 && resp.statusCode < 300) resolve();
        else reject(new Error(`Upload failed: ${resp.statusCode} ${data}`));
      });
    });
    req.on('error', reject);
    fileStream.pipe(req);
  });
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function unzipEpub(epubPath, destDir) {
  const { execFile } = require('child_process');
  fs.mkdirSync(destDir, { recursive: true });
  return new Promise((resolve, reject) => {
    execFile('unzip', ['-o', '-q', epubPath, '-d', destDir], { timeout: 60000 }, (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

function zipEpub(sourceDir, outputPath) {
  const { exec } = require('child_process');
  const mimetypePath = path.join(sourceDir, 'mimetype');
  const run = (cmd) => new Promise((resolve, reject) => {
    exec(cmd, { shell: true, timeout: 120000 }, (err) => { if (err) reject(err); else resolve(); });
  });
  if (fs.existsSync(mimetypePath)) {
    return run(`cd "${sourceDir}" && zip -0 -X "${outputPath}" mimetype`)
      .then(() => run(`cd "${sourceDir}" && zip -r -X "${outputPath}" . -x mimetype`));
  }
  return run(`cd "${sourceDir}" && zip -r -X "${outputPath}" .`);
}

function findHtmlFiles(unpackDir) {
  const result = [];
  const opfPath = findOpfFile(unpackDir);
  if (opfPath) {
    const opfContent = fs.readFileSync(opfPath, 'utf-8');
    const opfDir = path.dirname(opfPath);
    // Parse spine itemrefs
    const spineMatch = opfContent.match(/<spine[^>]*>([\s\S]*?)<\/spine>/i);
    if (spineMatch) {
      const itemrefRe = /idref\s*=\s*"([^"]+)"/gi;
      const idrefs = [];
      let m;
      while ((m = itemrefRe.exec(spineMatch[1])) !== null) idrefs.push(m[1]);

      // Build id -> href map from manifest
      const manifestMatch = opfContent.match(/<manifest[^>]*>([\s\S]*?)<\/manifest>/i);
      const idMap = {};
      if (manifestMatch) {
        const itemRe = /<item\s[^>]*?id\s*=\s*"([^"]+)"[^>]*?href\s*=\s*"([^"]+)"[^>]*?\/?>/gi;
        while ((m = itemRe.exec(manifestMatch[1])) !== null) idMap[m[1]] = m[2];
      }

      for (const idref of idrefs) {
        const href = idMap[idref];
        if (href && /\.(x?html?)$/i.test(href)) {
          const fullPath = path.join(opfDir, decodeURIComponent(href));
          if (fs.existsSync(fullPath)) result.push(fullPath);
        }
      }
    }
  }

  if (result.length === 0) {
    // Fallback: scan for .xhtml/.html files
    walkDir(unpackDir, (fp) => {
      if (/\.(x?html?)$/i.test(fp)) result.push(fp);
    });
    result.sort();
  }
  return result;
}

function findOpfFile(dir) {
  const containerPath = path.join(dir, 'META-INF', 'container.xml');
  if (fs.existsSync(containerPath)) {
    const content = fs.readFileSync(containerPath, 'utf-8');
    const m = content.match(/full-path\s*=\s*"([^"]+\.opf)"/i);
    if (m) {
      const opf = path.join(dir, m[1]);
      if (fs.existsSync(opf)) return opf;
    }
  }
  let found = null;
  walkDir(dir, (fp) => {
    if (!found && fp.endsWith('.opf')) found = fp;
  });
  return found;
}

function walkDir(dir, callback) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fp = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDir(fp, callback);
    else callback(fp);
  }
}

// EPUB HTML 解析 (cheerio, 兼容 XHTML/命名空间，对齐 Python epub_util)
const SKIP_TAGS = new Set(['script', 'style', 'code', 'pre']);
const TRANSLATION_CSS = `<style type="text/css">
  .translation-container { display: block; }
  .original-text { display: block; }
  .translated-text { display: block; margin-top: 4px; color: #666; font-size: 1.0em; }
</style>`;

function loadHtml(raw) {
  const isXhtml = raw.startsWith('<?xml') || /xmlns=/.test(raw.slice(0, 500)) || /<!DOCTYPE/i.test(raw.slice(0, 200));
  return cheerio.load(raw, { xmlMode: !!isXhtml, decodeEntities: true });
}

function collectTextNodes($, bodyNode, segments, nodeRefs) {
  const inTransContainer = (node) => {
    let p = node.parent;
    while (p) {
      if (p.type === 'tag' && p.attribs && /translation-container/.test(p.attribs.class || '')) return true;
      p = p.parent;
    }
    return false;
  };
  const isTranslatable = (t) => t && t.trim() && /[a-zA-Z\u4e00-\u9fff]/.test(t);
  const walk = (node) => {
    if (!node) return;
    if (node.type === 'tag') {
      const tag = (node.name || '').toLowerCase();
      if (SKIP_TAGS.has(tag)) return;
      if (/translation-container/.test(node.attribs?.class || '')) return;
      for (const c of node.children || []) walk(c);
    } else if (node.type === 'text') {
      const t = (node.data || '').trim();
      if (isTranslatable(t) && !inTransContainer(node)) {
        segments.push(t);
        nodeRefs.push(node);
      }
    }
  };
  walk(bodyNode);
}

/** 解码 HTML 实体（如 &#45556;、&#x4E2D;），避免 LLM 输出实体导致 EPUB 乱码 */
function decodeHtmlEntities(s) {
  if (!s || typeof s !== 'string') return s;
  return s
    .replace(/&#(\d{1,7});?/g, (_, d) => {
      const n = parseInt(d, 10);
      return (n >= 0 && n <= 0x10FFFF) ? String.fromCodePoint(n) : _;
    })
    .replace(/&#x([0-9a-fA-F]{1,6});?/g, (_, h) => {
      const n = parseInt(h, 16);
      return (n <= 0x10FFFF) ? String.fromCodePoint(n) : _;
    });
}

function extractAndPrepare(htmlPath) {
  const raw = fs.readFileSync(htmlPath, 'utf-8');
  const $ = loadHtml(raw);
  const body = $('body').get(0);
  if (!body) return { texts: [], writeBack: () => {} };

  const segments = [];
  const nodeRefs = [];
  collectTextNodes($, body, segments, nodeRefs);

  // 提取并保留 XML 声明、DOCTYPE（与 Python 一致）
  let xmlDecl = '';
  if (raw.startsWith('<?xml')) {
    const end = raw.indexOf('?>') + 2;
    xmlDecl = raw.slice(0, end);
  }
  let doctype = '';
  const dtStart = raw.indexOf('<!DOCTYPE');
  if (dtStart !== -1) {
    const dtEnd = raw.indexOf('>', dtStart) + 1;
    doctype = raw.slice(dtStart, dtEnd);
  }

  return {
    texts: segments,
    writeBack: (translatedTexts, outputMode) => {
      const isBilingual = outputMode.toUpperCase() === 'BILINGUAL';
      if (isBilingual) {
        const head = $('head');
        if (head.length && !raw.includes('translation-container')) {
          head.append(TRANSLATION_CSS);
        }
      }
      const count = Math.min(nodeRefs.length, translatedTexts.length);
      let replacedCount = 0;
      for (let i = 0; i < count; i++) {
        let translated = translatedTexts[i];
        if (translated != null) translated = String(translated).trim();
        if (!translated || translated === segments[i]) continue;
        translated = decodeHtmlEntities(translated);
        const node = nodeRefs[i];
        const escaped = translated.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        if (isBilingual) {
          const orig = (segments[i] || '').trim();
          const container = $(`<div class="translation-container"></div>`);
          container.append($(`<span class="original-text" data-translation="original">${orig.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>`));
          container.append($(`<div class="translated-text" data-translation="translated">${escaped}</div>`));
          $(node).replaceWith(container.get(0));
        } else {
          node.data = translated;
        }
        replacedCount++;
      }
      if (replacedCount === 0 && segments.length > 0) {
        console.warn(`[writeBack] WARNING: ${path.basename(htmlPath)} has ${segments.length} segments but 0 written back (translatedTexts.len=${translatedTexts.length})`);
      }
      let out = $.html();
      if (xmlDecl || doctype) {
        if (xmlDecl) out = out.replace(xmlDecl, '');
        if (doctype) out = out.replace(new RegExp(doctype.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '');
        out = (xmlDecl ? xmlDecl + '\n' : '') + (doctype ? doctype + '\n' : '') + out;
      }
      fs.writeFileSync(htmlPath, out, 'utf-8');
    },
  };
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization,accept,x-device-id,x-api-key,x-auth-token');
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
    // --- Auth ---
    if (req.method === 'POST' && pathname === '/auth/sms/send') {
      if (!verifyApiKey(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const phone = String(body.phone || '').trim();
      if (!phone || phone.replace(/[^0-9]/g, '').length !== 11) {
        return sendJson(res, 400, { error: 'InvalidPhone', message: '请输入正确的手机号' });
      }
      const result = await sendSmsCode(phone);
      if (result.error) return sendJson(res, 429, result);
      return sendJson(res, 200, { success: true });
    }

    if (req.method === 'POST' && pathname === '/auth/sms/verify') {
      if (!verifyApiKey(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const phone = String(body.phone || '').trim();
      const code = String(body.code || '').trim();
      if (!phone || !code) return sendJson(res, 400, { error: 'MissingFields' });
      if (!verifySmsCode(phone, code)) {
        return sendJson(res, 400, { error: 'InvalidCode', message: '验证码错误或已过期' });
      }
      const isNew = !fs.existsSync(_userFile(phone.replace(/[^0-9]/g, '')));
      const user = findOrCreateUser(phone);
      const cfg = loadConfig();
      const grantResult = ensureInitialGrant(user.userId, true);
      // Merge device anonymous points INTO userId (additive), then reset device
      const deviceId = String(req.headers['x-device-id'] || body.deviceId || '').trim();
      if (deviceId && deviceId !== user.userId) {
        const deviceBalance = readPointsBalance(deviceId);
        if (deviceBalance > 0) {
          const userBalance = readPointsBalance(user.userId);
          const merged = userBalance + deviceBalance;
          writePointsBalance(user.userId, merged);
          writePointsBalance(deviceId, 0);
          console.log(`[Auth] Merged device ${deviceId} points (+${deviceBalance}) into user ${user.userId}, new balance=${merged}`);
        }
      }
      if (deviceId && !user.devices.includes(deviceId)) {
        user.devices.push(deviceId);
        fs.writeFileSync(_userFile(phone.replace(/[^0-9]/g, '')), JSON.stringify(user, null, 2), 'utf-8');
      }
      const balance = readPointsBalance(user.userId);
      return sendJson(res, 200, {
        token: user.token, userId: user.userId,
        phone: user.phone.substring(0, 3) + '****' + user.phone.substring(7),
        balance, isNewUser: isNew,
        initialGrantedThisTime: grantResult.initialGrantedThisTime,
        initialGrantPoints: grantResult.initialGrantedThisTime ? (Number(cfg.initial_grant_points) || 500000) : undefined,
      });
    }

    if (req.method === 'POST' && pathname === '/auth/profile') {
      if (!verifyApiKey(req)) return sendJson(res, 401, { error: 'Unauthorized' });
      const user = getUserByToken(String(req.headers['x-auth-token'] || '').trim());
      if (!user) return sendJson(res, 401, { error: 'NotLoggedIn', message: '未登录' });
      const balance = readPointsBalance(user.userId);
      return sendJson(res, 200, {
        userId: user.userId,
        phone: user.phone.substring(0, 3) + '****' + user.phone.substring(7),
        balance, createdAt: user.createdAt, loginCount: user.loginCount,
      });
    }

    if (req.method === 'POST' && pathname === '/auth/logout') {
      const token = String(req.headers['x-auth-token'] || '').trim();
      const deviceId = String(req.headers['x-device-id'] || '').trim();
      if (token) revokeToken(token);
      // Reset device points to 0 after logout (points stay with account)
      if (deviceId) {
        writePointsBalance(deviceId, 0);
        console.log(`[Auth] Reset device ${deviceId} points to 0 after logout`);
      }
      return sendJson(res, 200, { success: true });
    }

    // --- Jobs (App-facing) ---
    if (req.method === 'POST' && pathname === '/jobs/create') return handleCreateJob(req, res, body);
    if (req.method === 'POST' && pathname === '/jobs/markUploaded') return handleMarkUploaded(res, body);
    if (req.method === 'POST' && pathname === '/jobs/start') return handleStartJob(res, body);
    if (req.method === 'GET' && pathname === '/jobs/progress') return handleGetProgress(res, String(url.searchParams.get('jobId') || '').trim());
    if (req.method === 'GET' && pathname === '/jobs/download') return handleGetDownloadUrl(res, String(url.searchParams.get('jobId') || '').trim(), url.searchParams.get('output'));
    if (req.method === 'GET' && pathname === '/jobs/list') return handleListJobs(req, res, String(url.searchParams.get('deviceId') || '').trim());
    if (req.method === 'POST' && pathname === '/jobs/delete') return handleDeleteJob(res, body);

    // --- Billing ---
    if (req.method === 'POST' && pathname === '/billing/init') return handleBillingInit(req, res, body);
    if (req.method === 'GET' && pathname === '/billing/balance') return handleBalance(req, res, String(url.searchParams.get('deviceId') || '').trim());

    // --- Config ---
    if (req.method === 'GET' && pathname === '/config') {
      const cfg = loadConfig();
      cfg.local_ai_available = isLocalAiAvailable();
      return sendJson(res, 200, cfg);
    }

    // --- Checkin ---
    if (req.method === 'POST' && pathname === '/checkin') return handleCheckin(req, res, body);
    if (req.method === 'POST' && pathname === '/checkin/status') return handleCheckinStatus(req, res, body);

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
