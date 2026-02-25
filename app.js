'use strict';

// =========================================================================
// AirTranslate SCF Gateway (v3 - simplified)
// - 只保留 App 面向的 API
// - 删除所有 /worker/* 路由 (Worker 直连 COS)
// - 引擎类型: MACHINE (免费) / AI (扣积分)
// - 创建任务时直接排队 + 预扣积分(AI)
// =========================================================================

const crypto = require('crypto');
const http = require('http');
const https = require('https');

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s || ''), 'utf8').digest('hex');
}

function sha1Hex(s) {
  return crypto.createHash('sha1').update(String(s || ''), 'utf8').digest('hex');
}

function hmacSha1Hex(key, msg) {
  return crypto.createHmac('sha1', String(key || '')).update(String(msg || ''), 'utf8').digest('hex');
}

function uriEncode(s) {
  return encodeURIComponent(String(s || '')).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function base64UrlDecode(str) {
  let s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function getEd25519PublicKey(base64Key) {
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  const rawKey = Buffer.from(String(base64Key || ''), 'base64');
  if (rawKey.length !== 32) throw new Error('Invalid Ed25519 public key length');
  return crypto.createPublicKey({ key: Buffer.concat([prefix, rawKey]), format: 'der', type: 'spki' });
}

function verifyEd25519(data, signature, publicKey) {
  return crypto.verify(null, data, publicKey, signature);
}

// ---------------------------------------------------------------------------
// COS 底层操作 (保持不变)
// ---------------------------------------------------------------------------

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

function getCosConfig() {
  const bucket = (process.env.BUCKET_NAME || process.env.COS_BUCKET_NAME || process.env.COS_BUCKET || '').trim();
  const region = (process.env.REGION || process.env.COS_REGION || '').trim();
  const jobsPrefix = String(process.env.COS_JOBS_PREFIX || 'jobs/').trim() || 'jobs/';
  const presignSeconds = Number(process.env.COS_PRESIGN_EXPIRES_SECONDS || '7200') || 7200;
  return { bucket, region, jobsPrefix, presignSeconds };
}

function buildKey(relativeKey) {
  const { jobsPrefix } = getCosConfig();
  let prefix = String(jobsPrefix || 'jobs/').trim();
  if (!prefix.endsWith('/')) prefix += '/';
  let rel = String(relativeKey || '');
  if (rel.startsWith('/')) rel = rel.slice(1);
  return prefix + rel;
}

function getCosCredentials() {
  const secretId = (process.env.TENCENT_SECRET_ID || process.env.COS_SECRET_ID || process.env.TENCENTCLOUD_SECRETID || '').trim();
  const secretKey = (process.env.TENCENT_SECRET_KEY || process.env.COS_SECRET_KEY || process.env.TENCENTCLOUD_SECRETKEY || '').trim();
  const sessionToken = (process.env.COS_SESSION_TOKEN || process.env.TENCENTCLOUD_SESSIONTOKEN || '').trim();
  return { secretId, secretKey, sessionToken };
}

function cosRequest({ method, bucket, region, key, headers, query, body }) {
  const { secretId, secretKey, sessionToken } = getCosCredentials();
  if (!secretId || !secretKey) return Promise.reject(new Error('Missing COS credentials'));
  const host = `${bucket}.cos.${region}.myqcloud.com`;
  const path = buildCosPath(key);
  const finalHeaders = Object.assign({}, headers || {});
  finalHeaders.host = host;
  if (sessionToken) finalHeaders['x-cos-security-token'] = sessionToken;
  const now = Math.floor(Date.now() / 1000);
  finalHeaders.Authorization = buildCosAuthorization({ secretId, secretKey, method, path, headers: finalHeaders, query: query || {}, startTime: now - 60, endTime: now + 600 });
  const queryKeys = Object.keys(query || {});
  const qs = queryKeys.length ? `?${queryKeys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(query[k] ?? ''))}`).join('&')}` : '';
  const options = { protocol: 'https:', hostname: host, method, path: path + qs, headers: finalHeaders };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (resp) => {
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => resolve({ statusCode: resp.statusCode || 0, headers: resp.headers || {}, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body && body.length) req.write(body);
    req.end();
  });
}

async function cosHeadObject({ bucket, region, key }) {
  const resp = await cosRequest({ method: 'HEAD', bucket, region, key, headers: {}, query: {}, body: null });
  return resp.statusCode || 0;
}

async function cosPutObject({ bucket, region, key, headers }) {
  const body = Buffer.from('');
  const resp = await cosRequest({ method: 'PUT', bucket, region, key, headers: Object.assign({ 'content-length': '0' }, headers || {}), query: {}, body });
  return resp.statusCode || 0;
}

async function cosGetObject({ bucket, region, key }) {
  const resp = await cosRequest({ method: 'GET', bucket, region, key, headers: {}, query: {}, body: null });
  if ((resp.statusCode || 0) !== 200) throw new Error(`COS GET ${key} status=${resp.statusCode || 0}`);
  return resp.body || Buffer.from('');
}

async function cosPutJson({ bucket, region, key, json }) {
  const body = Buffer.from(JSON.stringify(json));
  const resp = await cosRequest({ method: 'PUT', bucket, region, key, headers: { 'content-length': String(body.length), 'content-type': 'application/json; charset=utf-8' }, query: {}, body });
  return resp.statusCode || 0;
}

async function cosListObjectsV2({ bucket, region, prefix, maxKeys }) {
  const resp = await cosRequest({ method: 'GET', bucket, region, key: '', headers: {}, query: { 'list-type': '2', prefix: String(prefix || ''), 'max-keys': String(maxKeys || 1000) }, body: null });
  if ((resp.statusCode || 0) !== 200) throw new Error(`COS ListObjectsV2 status=${resp.statusCode || 0}`);
  return resp.body ? resp.body.toString('utf8') : '';
}

function cosPresignUrl({ method, bucket, region, key, expiresSeconds, headers }) {
  const { secretId, secretKey, sessionToken } = getCosCredentials();
  if (!secretId || !secretKey) throw new Error('Missing COS credentials');
  const host = `${bucket}.cos.${region}.myqcloud.com`;
  const path = buildCosPath(key);
  const finalHeaders = Object.assign({}, headers || {});
  finalHeaders.host = host;
  const now = Math.floor(Date.now() / 1000);
  const sign = buildCosAuthorization({ secretId, secretKey, method, path, headers: finalHeaders, query: {}, startTime: now - 60, endTime: now + Math.max(60, Math.min(86400, Number(expiresSeconds) || 7200)) });
  const tokenPart = sessionToken ? `&x-cos-security-token=${encodeURIComponent(sessionToken)}` : '';
  return `https://${host}${path}?${sign}${tokenPart}`;
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
// 积分管理
// ---------------------------------------------------------------------------

const UNIT_CHARS = Number(process.env.BILLING_UNIT_CHARS || '1000') || 1000;
const UNIT_COST = Number(process.env.BILLING_UNIT_COST || '1') || 1;

async function readPointsBalance({ bucket, region, deviceId }) {
  const key = buildKey(`_billing/points/${deviceId}.json`);
  try {
    const buf = await cosGetObject({ bucket, region, key });
    const obj = JSON.parse(buf.toString('utf8'));
    const prev = Number(obj && obj.balance ? obj.balance : 0) || 0;
    return prev < 0 ? 0 : prev;
  } catch (_) {
    return 0;
  }
}

async function writePointsBalance({ bucket, region, deviceId, balance }) {
  const key = buildKey(`_billing/points/${deviceId}.json`);
  const next = balance < 0 ? 0 : balance;
  const status = await cosPutJson({ bucket, region, key, json: { balance: next, updatedAt: new Date().toISOString() } });
  if (status < 200 || status >= 300) throw new Error(`COS Put Points Error: ${status}`);
  return next;
}

// ---------------------------------------------------------------------------
// API: POST /jobs/create
// ---------------------------------------------------------------------------

async function handleCreateJob(res, body) {
  const { bucket, region, presignSeconds } = getCosConfig();
  if (!bucket || !region) return sendJson(res, 500, { error: 'ServerMisconfiguration' });

  const engineType = normalizeEngineType(body.engineType || body.engine);
  const output = normalizeOutput(body.output);
  const deviceId = String(body.deviceId || body.device_id || '').trim();
  const sourceLang = String(body.sourceLang || body.source_lang || 'auto').trim() || 'auto';
  const targetLang = String(body.targetLang || body.target_lang || '').trim();
  const sourceFileName = String(body.sourceFileName || body.source_file_name || '').trim();
  const charCount = Number(body.charCount || 0) || 0;
  const useContext = Boolean(body.useContext);
  const useGlossary = Boolean(body.useGlossary);

  if (!targetLang) return sendJson(res, 400, { error: 'BadRequest', message: 'targetLang required' });
  if (!sourceFileName) return sendJson(res, 400, { error: 'BadRequest', message: 'sourceFileName required' });
  if (!deviceId) return sendJson(res, 400, { error: 'BadRequest', message: 'deviceId required' });

  // AI翻译: 预扣积分
  let pointsDeducted = 0;
  if (engineType === 'AI' && charCount > 0) {
    pointsDeducted = Math.ceil(charCount / UNIT_CHARS) * UNIT_COST;
    const balance = await readPointsBalance({ bucket, region, deviceId });
    if (balance < pointsDeducted) {
      return sendJson(res, 409, { error: 'POINTS_INSUFFICIENT', need: pointsDeducted, balance });
    }
    await writePointsBalance({ bucket, region, deviceId, balance: balance - pointsDeducted });
  }

  const jobId = crypto.randomBytes(16).toString('hex');
  const nowIso = new Date().toISOString();

  const spec = {
    jobId, engineType, output, deviceId, sourceLang, targetLang,
    sourceFileName, charCount, useContext, useGlossary,
    pointsDeducted, createdAt: nowIso,
  };
  const progress = { jobId, state: 'CREATED', percent: 0, engineType, output, updatedAt: nowIso };

  const st1 = await cosPutJson({ bucket, region, key: buildKey(`${jobId}/job.json`), json: spec });
  const st2 = await cosPutJson({ bucket, region, key: buildKey(`${jobId}/progress.json`), json: progress });
  if (st1 < 200 || st1 >= 300 || st2 < 200 || st2 >= 300) {
    // 回退积分
    if (pointsDeducted > 0) {
      const cur = await readPointsBalance({ bucket, region, deviceId });
      await writePointsBalance({ bucket, region, deviceId, balance: cur + pointsDeducted });
    }
    return sendJson(res, 500, { error: 'CosWriteFailed' });
  }

  // 生成上传 presign URL
  const sourceKey = buildKey(`${jobId}/source/source.epub`);
  const uploadUrl = cosPresignUrl({ method: 'PUT', bucket, region, key: sourceKey, expiresSeconds: presignSeconds, headers: { 'content-type': 'application/epub+zip' } });

  // 术语表上传 URL (AI + useGlossary)
  let glossaryUpload = null;
  if (engineType === 'AI' && useGlossary) {
    const glossaryKey = buildKey(`${jobId}/glossary.json`);
    const glossaryUrl = cosPresignUrl({ method: 'PUT', bucket, region, key: glossaryKey, expiresSeconds: presignSeconds, headers: { 'content-type': 'application/json' } });
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
// API: POST /jobs/markUploaded  (App上传完EPUB后调用，排队)
// ---------------------------------------------------------------------------

async function handleMarkUploaded(res, body) {
  const { bucket, region } = getCosConfig();
  if (!bucket || !region) return sendJson(res, 500, { error: 'ServerMisconfiguration' });
  const jobId = String(body.jobId || '').trim();
  if (!jobId) return sendJson(res, 400, { error: 'BadRequest', message: 'jobId required' });

  const progressKey = buildKey(`${jobId}/progress.json`);
  let progress;
  try {
    const buf = await cosGetObject({ bucket, region, key: progressKey });
    progress = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    return sendJson(res, 404, { error: 'NotFound' });
  }
  progress.state = 'UPLOADED';
  progress.updatedAt = new Date().toISOString();
  const st = await cosPutJson({ bucket, region, key: progressKey, json: progress });
  if (st < 200 || st >= 300) return sendJson(res, 500, { error: 'CosWriteFailed' });

  // 加入队列
  const queueKey = buildKey(`_queue/pending/${jobId}`);
  const qst = await cosPutObject({ bucket, region, key: queueKey, headers: {} });
  if (qst < 200 || qst >= 300) return sendJson(res, 500, { error: 'CosQueueFailed' });

  return sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// API: GET /jobs/progress
// ---------------------------------------------------------------------------

async function handleGetProgress(res, jobId) {
  const { bucket, region } = getCosConfig();
  if (!bucket || !region) return sendJson(res, 500, { error: 'ServerMisconfiguration' });
  if (!jobId) return sendJson(res, 400, { error: 'BadRequest', message: 'jobId required' });

  let progress;
  try {
    const buf = await cosGetObject({ bucket, region, key: buildKey(`${jobId}/progress.json`) });
    progress = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    return sendJson(res, 404, { error: 'NotFound' });
  }

  // 失败时自动退还积分
  if (progress.state === 'FAILED' && !progress._refunded) {
    try {
      const jobBuf = await cosGetObject({ bucket, region, key: buildKey(`${jobId}/job.json`) });
      const job = JSON.parse(jobBuf.toString('utf8'));
      if (job.pointsDeducted > 0 && job.deviceId) {
        const cur = await readPointsBalance({ bucket, region, deviceId: job.deviceId });
        await writePointsBalance({ bucket, region, deviceId: job.deviceId, balance: cur + job.pointsDeducted });
        progress._refunded = true;
        progress.refundedPoints = job.pointsDeducted;
        await cosPutJson({ bucket, region, key: buildKey(`${jobId}/progress.json`), json: progress });
      }
    } catch (_) { /* best effort */ }
  }

  return sendJson(res, 200, progress);
}

// ---------------------------------------------------------------------------
// API: GET /jobs/download
// ---------------------------------------------------------------------------

async function handleGetDownloadUrl(res, jobId, output) {
  const { bucket, region, presignSeconds } = getCosConfig();
  if (!bucket || !region) return sendJson(res, 500, { error: 'ServerMisconfiguration' });
  if (!jobId) return sendJson(res, 400, { error: 'BadRequest', message: 'jobId required' });

  let progress;
  try {
    const buf = await cosGetObject({ bucket, region, key: buildKey(`${jobId}/progress.json`) });
    progress = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    return sendJson(res, 404, { error: 'NotFound' });
  }
  if (String(progress.state || '').toUpperCase() !== 'DONE') {
    return sendJson(res, 409, { error: 'NotReady', message: 'job not done' });
  }

  const o = normalizeOutput(output || progress.output);
  const cosKey = o === 'BILINGUAL' ? buildKey(`${jobId}/result/bilingual.epub`) : buildKey(`${jobId}/result/translated.epub`);
  const url = cosPresignUrl({ method: 'GET', bucket, region, key: cosKey, expiresSeconds: presignSeconds, headers: {} });
  return sendJson(res, 200, { cosKey, url, expiresInSeconds: presignSeconds });
}

// ---------------------------------------------------------------------------
// API: GET /jobs/list  (新增)
// ---------------------------------------------------------------------------

async function handleListJobs(res, deviceId) {
  const { bucket, region } = getCosConfig();
  if (!bucket || !region) return sendJson(res, 500, { error: 'ServerMisconfiguration' });
  if (!deviceId) return sendJson(res, 400, { error: 'BadRequest', message: 'deviceId required' });

  const prefix = buildKey('');
  const xml = await cosListObjectsV2({ bucket, region, prefix, maxKeys: 500 });

  // 提取所有 job.json key
  const jobKeyRegex = /<Key>([^<]*\/job\.json)<\/Key>/g;
  const jobs = [];
  let match;
  while ((match = jobKeyRegex.exec(xml)) !== null) {
    try {
      const buf = await cosGetObject({ bucket, region, key: match[1] });
      const job = JSON.parse(buf.toString('utf8'));
      if (job.deviceId === deviceId) {
        // 也读取进度
        const progressKey = match[1].replace('/job.json', '/progress.json');
        let progress = {};
        try {
          const pBuf = await cosGetObject({ bucket, region, key: progressKey });
          progress = JSON.parse(pBuf.toString('utf8'));
        } catch (_) {}
        jobs.push({ ...job, progress });
      }
    } catch (_) {}
  }

  // 按创建时间倒序
  jobs.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return sendJson(res, 200, { jobs });
}

// ---------------------------------------------------------------------------
// API: GET /billing/balance
// ---------------------------------------------------------------------------

async function handleBalance(res, deviceId) {
  const { bucket, region } = getCosConfig();
  if (!bucket || !region) return sendJson(res, 500, { error: 'ServerMisconfiguration' });
  if (!deviceId) return sendJson(res, 400, { error: 'BadRequest', message: 'deviceId required' });
  const balance = await readPointsBalance({ bucket, region, deviceId });
  return sendJson(res, 200, { deviceId, balance });
}

// ---------------------------------------------------------------------------
// API: POST /billing/redeem
// ---------------------------------------------------------------------------

async function handleRedeem(res, body) {
  const { bucket, region } = getCosConfig();
  if (!bucket || !region) return sendJson(res, 500, { error: 'ServerMisconfiguration' });

  const licenseCode = String(body.licenseCode || body.license_code || '').trim();
  const deviceId = String(body.deviceId || body.device_id || '').trim();
  if (!licenseCode) return sendJson(res, 400, { error: 'BadRequest', message: 'licenseCode required' });
  if (!deviceId) return sendJson(res, 400, { error: 'BadRequest', message: 'deviceId required' });

  // Ed25519 验签
  const pubKeyB64 = String(process.env.LICENSE_PUBLIC_KEY || '').trim();
  let pointsIndex = null;
  if (pubKeyB64) {
    try {
      if (!licenseCode.startsWith('P3')) throw new Error('Invalid version');
      const bytes = base64UrlDecode(licenseCode.substring(2));
      if (bytes.length !== 5 + 64) throw new Error('Invalid length');
      const payload = bytes.slice(0, 5);
      const signature = bytes.slice(5);
      const publicKey = getEd25519PublicKey(pubKeyB64);
      if (!verifyEd25519(payload, signature, publicKey)) {
        return sendJson(res, 403, { error: 'InvalidLicenseSignature' });
      }
      pointsIndex = payload[0];
    } catch (e) {
      return sendJson(res, 400, { error: 'InvalidLicenseFormat', message: String(e && e.message ? e.message : e) });
    }
  }

  // 防重复兑换
  const codeHash = sha256Hex(licenseCode);
  const usedKey = buildKey(`_billing/used_keys/${codeHash}.json`);
  const headStatus = await cosHeadObject({ bucket, region, key: usedKey });
  if (headStatus === 200) return sendJson(res, 409, { used: true, alreadyUsed: true, codeHash });
  if (headStatus !== 404) return sendJson(res, 500, { error: 'CosHeadFailed', statusCode: headStatus });

  const putStatus = await cosPutObject({ bucket, region, key: usedKey, headers: { 'x-cos-meta-device-id': deviceId, 'x-cos-meta-redeemed-at': new Date().toISOString() } });
  if (putStatus < 200 || putStatus >= 300) return sendJson(res, 500, { error: 'CosWriteFailed', statusCode: putStatus });

  const map = [50000, 100000, 200000, 500000, 1000000];
  const idx = pointsIndex == null ? 0 : Number(pointsIndex);
  const pointsAdded = idx >= 0 && idx < map.length ? map[idx] : 0;
  if (pointsAdded <= 0) return sendJson(res, 400, { error: 'UnsupportedPointsIndex' });

  const prev = await readPointsBalance({ bucket, region, deviceId });
  const balance = await writePointsBalance({ bucket, region, deviceId, balance: prev + pointsAdded });

  return sendJson(res, 200, { used: false, alreadyUsed: false, codeHash, pointsAdded, balance });
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization,accept');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.end();
    return;
  }

  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname || '/';

  let body = {};
  if (req.method === 'POST') {
    try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'InvalidJson', message: String(e?.message || e) }); }
  }

  try {
    // --- Jobs ---
    if (req.method === 'POST' && pathname === '/jobs/create') return await handleCreateJob(res, body);
    if (req.method === 'POST' && pathname === '/jobs/markUploaded') return await handleMarkUploaded(res, body);
    if (req.method === 'GET' && pathname === '/jobs/progress') return await handleGetProgress(res, String(url.searchParams.get('jobId') || '').trim());
    if (req.method === 'GET' && pathname === '/jobs/download') return await handleGetDownloadUrl(res, String(url.searchParams.get('jobId') || '').trim(), url.searchParams.get('output'));
    if (req.method === 'GET' && pathname === '/jobs/list') return await handleListJobs(res, String(url.searchParams.get('deviceId') || '').trim());

    // --- Billing ---
    if (req.method === 'POST' && pathname === '/billing/redeem') return await handleRedeem(res, body);
    if (req.method === 'GET' && pathname === '/billing/balance') return await handleBalance(res, String(url.searchParams.get('deviceId') || '').trim());
  } catch (e) {
    return sendJson(res, 500, { error: 'InternalError', message: String(e?.message || e) });
  }

  sendJson(res, 404, { error: 'NotFound' });
});

const port = process.env.PORT ? Number(process.env.PORT) : 9000;
server.listen(port);
