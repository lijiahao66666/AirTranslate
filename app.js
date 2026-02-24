'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');

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
  if (rawKey.length !== 32) {
    throw new Error('Invalid Ed25519 public key length');
  }
  const der = Buffer.concat([prefix, rawKey]);
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

function verifyEd25519(data, signature, publicKey) {
  return crypto.verify(null, data, publicKey, signature);
}

function buildCosAuthorization({ secretId, secretKey, method, path, headers, query, startTime, endTime }) {
  const signTime = `${startTime};${endTime}`;
  const keyTime = signTime;
  const signKey = hmacSha1Hex(secretKey, keyTime);

  const headerKeys = Object.keys(headers || {}).map((k) => k.toLowerCase()).sort();
  const headerList = headerKeys.join(';');
  const headerString = headerKeys.map((k) => `${k}=${uriEncode(String(headers[k] ?? '').trim())}`).join('&');

  const queryKeys = Object.keys(query || {}).map((k) => k.toLowerCase()).sort();
  const queryList = queryKeys.join(';');
  const queryString = queryKeys.map((k) => `${k}=${uriEncode(String(query[k] ?? '').trim())}`).join('&');

  const formatString = [String(method || 'get').toLowerCase(), path, queryString, headerString, ''].join('\n');
  const stringToSign = ['sha1', keyTime, sha1Hex(formatString), ''].join('\n');
  const signature = hmacSha1Hex(signKey, stringToSign);
  return `q-sign-algorithm=sha1&q-ak=${secretId}&q-sign-time=${signTime}&q-key-time=${keyTime}&q-header-list=${headerList}&q-url-param-list=${queryList}&q-signature=${signature}`;
}

function buildCosPath(key) {
  const encoded = String(key || '')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `/${encoded}`;
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
  const secretId =
    (process.env.TENCENT_SECRET_ID || process.env.COS_SECRET_ID || process.env.TENCENTCLOUD_SECRETID || '').trim();
  const secretKey =
    (process.env.TENCENT_SECRET_KEY || process.env.COS_SECRET_KEY || process.env.TENCENTCLOUD_SECRETKEY || '').trim();
  const sessionToken = (process.env.COS_SESSION_TOKEN || process.env.TENCENTCLOUD_SESSIONTOKEN || '').trim();
  return { secretId, secretKey, sessionToken };
}

function cosRequest({ method, bucket, region, key, headers, query, body }) {
  const { secretId, secretKey, sessionToken } = getCosCredentials();
  if (!secretId || !secretKey) {
    return Promise.reject(new Error('Missing COS credentials'));
  }
  const host = `${bucket}.cos.${region}.myqcloud.com`;
  const path = buildCosPath(key);
  const finalHeaders = Object.assign({}, headers || {});
  finalHeaders.host = host;
  if (sessionToken) {
    finalHeaders['x-cos-security-token'] = sessionToken;
  }
  const now = Math.floor(Date.now() / 1000);
  const authorization = buildCosAuthorization({
    secretId,
    secretKey,
    method,
    path,
    headers: finalHeaders,
    query: query || {},
    startTime: now - 60,
    endTime: now + 600,
  });
  finalHeaders.Authorization = authorization;

  const queryKeys = Object.keys(query || {});
  const qs = queryKeys.length
    ? `?${queryKeys
        .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(query[k] ?? ''))}`)
        .join('&')}`
    : '';

  const options = { protocol: 'https:', hostname: host, method, path: path + qs, headers: finalHeaders };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (resp) => {
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => {
        resolve({ statusCode: resp.statusCode || 0, headers: resp.headers || {}, body: Buffer.concat(chunks) });
      });
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
  const resp = await cosRequest({
    method: 'PUT',
    bucket,
    region,
    key,
    headers: Object.assign({ 'content-length': String(body.length) }, headers || {}),
    query: {},
    body,
  });
  return resp.statusCode || 0;
}

async function cosGetObject({ bucket, region, key }) {
  const resp = await cosRequest({ method: 'GET', bucket, region, key, headers: {}, query: {}, body: null });
  if ((resp.statusCode || 0) !== 200) {
    throw new Error(`COS GET ${key} status=${resp.statusCode || 0}`);
  }
  return resp.body || Buffer.from('');
}

async function cosPutJson({ bucket, region, key, json }) {
  const body = Buffer.from(JSON.stringify(json));
  const resp = await cosRequest({
    method: 'PUT',
    bucket,
    region,
    key,
    headers: { 'content-length': String(body.length), 'content-type': 'application/json; charset=utf-8' },
    query: {},
    body,
  });
  return resp.statusCode || 0;
}

async function cosDeleteObject({ bucket, region, key }) {
  const resp = await cosRequest({ method: 'DELETE', bucket, region, key, headers: {}, query: {}, body: null });
  return resp.statusCode || 0;
}

async function cosListObjectsV2({ bucket, region, prefix, maxKeys }) {
  const resp = await cosRequest({
    method: 'GET',
    bucket,
    region,
    key: '',
    headers: {},
    query: { 'list-type': '2', prefix: String(prefix || ''), 'max-keys': String(maxKeys || 1000) },
    body: null,
  });
  if ((resp.statusCode || 0) !== 200) {
    throw new Error(`COS ListObjectsV2 status=${resp.statusCode || 0}`);
  }
  return resp.body ? resp.body.toString('utf8') : '';
}

function cosPresignUrl({ method, bucket, region, key, expiresSeconds, headers }) {
  const { secretId, secretKey, sessionToken } = getCosCredentials();
  if (!secretId || !secretKey) {
    throw new Error('Missing COS credentials');
  }
  const host = `${bucket}.cos.${region}.myqcloud.com`;
  const path = buildCosPath(key);

  const finalHeaders = Object.assign({}, headers || {});
  finalHeaders.host = host;

  const now = Math.floor(Date.now() / 1000);
  const sign = buildCosAuthorization({
    secretId,
    secretKey,
    method,
    path,
    headers: finalHeaders,
    query: {},
    startTime: now - 60,
    endTime: now + Math.max(60, Math.min(86400, Number(expiresSeconds) || 7200)),
  });

  const tokenPart = sessionToken ? `&x-cos-security-token=${encodeURIComponent(sessionToken)}` : '';
  return `https://${host}${path}?${sign}${tokenPart}`;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (data.length > 4 * 1024 * 1024) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
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
  const o = String(output || '').trim().toUpperCase();
  if (o === 'BILINGUAL') return 'BILINGUAL';
  return 'TRANSLATED_ONLY';
}

function requireWorkerAuth(req, res) {
  const secret = String(process.env.WORKER_SECRET || process.env.SCF_WORKER_SECRET || '').trim();
  if (!secret) return true;
  const provided = String(req.headers['x-worker-secret'] || '').trim();
  if (provided && provided === secret) return true;
  sendJson(res, 403, { error: 'Forbidden' });
  return false;
}

async function handleWorkerNext(req, res) {
  if (!requireWorkerAuth(req, res)) return;
  const { bucket, region } = getCosConfig();
  if (!bucket || !region) {
    return sendJson(res, 500, { error: 'ServerMisconfiguration', message: 'BUCKET_NAME and REGION must be set' });
  }

  const queuePrefix = buildKey('_queue/pending/');
  const xml = await cosListObjectsV2({ bucket, region, prefix: queuePrefix, maxKeys: 1 });
  const match = xml.match(/<Key>([^<]+)<\/Key>/);
  if (!match) {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end();
    return;
  }
  const key = match[1];
  if (!String(key).startsWith(queuePrefix)) {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end();
    return;
  }

  const delStatus = await cosDeleteObject({ bucket, region, key });
  if (delStatus < 200 || delStatus >= 300) {
    return sendJson(res, 500, { error: 'CosDeleteFailed', statusCode: delStatus });
  }
  const jobId = String(key).substring(queuePrefix.length);
  return sendJson(res, 200, { jobId });
}

async function handleWorkerGetJson(req, res, key) {
  if (!requireWorkerAuth(req, res)) return;
  const { bucket, region } = getCosConfig();
  if (!bucket || !region) {
    return sendJson(res, 500, { error: 'ServerMisconfiguration', message: 'BUCKET_NAME and REGION must be set' });
  }
  try {
    const buf = await cosGetObject({ bucket, region, key });
    return sendJson(res, 200, JSON.parse(buf.toString('utf8')));
  } catch (e) {
    return sendJson(res, 404, { error: 'NotFound' });
  }
}

async function handleWorkerGetObjectString(req, res, cosKey) {
  if (!requireWorkerAuth(req, res)) return;
  const { bucket, region } = getCosConfig();
  if (!bucket || !region) {
    return sendJson(res, 500, { error: 'ServerMisconfiguration', message: 'BUCKET_NAME and REGION must be set' });
  }
  const key = String(cosKey || '').trim();
  if (!key) return sendJson(res, 400, { error: 'BadRequest', message: 'cosKey required' });
  try {
    const buf = await cosGetObject({ bucket, region, key });
    return sendJson(res, 200, { cosKey: key, content: buf.toString('utf8') });
  } catch (e) {
    return sendJson(res, 404, { error: 'NotFound' });
  }
}

async function handleWorkerPutJson(req, res, key, body) {
  if (!requireWorkerAuth(req, res)) return;
  const { bucket, region } = getCosConfig();
  if (!bucket || !region) {
    return sendJson(res, 500, { error: 'ServerMisconfiguration', message: 'BUCKET_NAME and REGION must be set' });
  }
  const status = await cosPutJson({ bucket, region, key, json: body || {} });
  if (status < 200 || status >= 300) {
    return sendJson(res, 500, { error: 'CosWriteFailed', statusCode: status });
  }
  return sendJson(res, 200, { ok: true });
}

async function handleWorkerSourceUrl(req, res, jobId) {
  if (!requireWorkerAuth(req, res)) return;
  const { bucket, region, presignSeconds } = getCosConfig();
  if (!bucket || !region) {
    return sendJson(res, 500, { error: 'ServerMisconfiguration', message: 'BUCKET_NAME and REGION must be set' });
  }
  if (!jobId) return sendJson(res, 400, { error: 'BadRequest', message: 'jobId required' });

  const cosKey = buildKey(`${jobId}/source/source.epub`);
  const url = cosPresignUrl({ method: 'GET', bucket, region, key: cosKey, expiresSeconds: presignSeconds, headers: {} });
  return sendJson(res, 200, { cosKey, url, expiresInSeconds: presignSeconds });
}

async function handleWorkerResultUrl(req, res, jobId, output) {
  if (!requireWorkerAuth(req, res)) return;
  const { bucket, region, presignSeconds } = getCosConfig();
  if (!bucket || !region) {
    return sendJson(res, 500, { error: 'ServerMisconfiguration', message: 'BUCKET_NAME and REGION must be set' });
  }
  if (!jobId) return sendJson(res, 400, { error: 'BadRequest', message: 'jobId required' });
  const o = normalizeOutput(output);
  const cosKey = o === 'BILINGUAL' ? buildKey(`${jobId}/result/bilingual.epub`) : buildKey(`${jobId}/result/translated.epub`);
  const url = cosPresignUrl({
    method: 'PUT',
    bucket,
    region,
    key: cosKey,
    expiresSeconds: presignSeconds,
    headers: { 'content-type': 'application/epub+zip' },
  });
  return sendJson(res, 200, { cosKey, url, method: 'PUT', contentType: 'application/epub+zip', expiresInSeconds: presignSeconds });
}

async function handleWorkerDeduct(req, res, body) {
  if (!requireWorkerAuth(req, res)) return;
  const { bucket, region } = getCosConfig();
  if (!bucket || !region) {
    return sendJson(res, 500, { error: 'ServerMisconfiguration', message: 'BUCKET_NAME and REGION must be set' });
  }
  const deviceId = String(body && (body.deviceId || body.device_id) ? (body.deviceId || body.device_id) : '').trim();
  const delta = Number(body && body.delta != null ? body.delta : 0) || 0;
  if (!deviceId) return sendJson(res, 400, { error: 'BadRequest', message: 'deviceId required' });
  if (delta <= 0) return sendJson(res, 200, { deviceId, balance: await readPointsBalance({ bucket, region, deviceId }) });

  const current = await readPointsBalance({ bucket, region, deviceId });
  if (current < delta) {
    return sendJson(res, 409, { error: 'POINTS_INSUFFICIENT', need: delta, balance: current });
  }
  const balance = await writePointsBalance({ bucket, region, deviceId, balance: current - delta });
  return sendJson(res, 200, { deviceId, balance });
}

async function handleCreateJob(res, body) {
  const { bucket, region, presignSeconds } = getCosConfig();
  if (!bucket || !region) {
    return sendJson(res, 500, { error: 'ServerMisconfiguration', message: 'COS_BUCKET_NAME/BUCKET_NAME and COS_REGION/REGION must be set' });
  }

  const engine = String(body.engine || body.translationEngine || '').trim().toUpperCase() || 'HY';
  const mode = String(body.mode || '').trim().toUpperCase() || 'PARAGRAPH';
  const output = normalizeOutput(body.output);
  const deviceId = String(body.deviceId || body.device_id || '').trim();
  const sourceLang = String(body.sourceLang || body.source_lang || 'auto').trim() || 'auto';
  const targetLang = String(body.targetLang || body.target_lang || '').trim();
  const sourceFileName = String(body.sourceFileName || body.source_file_name || '').trim();
  const glossaryCosKey = String(body.glossaryCosKey || body.glossary_cos_key || '').trim() || null;
  const clientInfo = body.clientInfo && typeof body.clientInfo === 'object' ? body.clientInfo : null;

  if (!targetLang) return sendJson(res, 400, { error: 'BadRequest', message: 'targetLang required' });
  if (!sourceFileName) return sendJson(res, 400, { error: 'BadRequest', message: 'sourceFileName required' });
  if (engine !== 'HY') return sendJson(res, 400, { error: 'BadRequest', message: 'only HY supported' });
  if (!deviceId) return sendJson(res, 400, { error: 'BadRequest', message: 'deviceId required for HY' });

  const jobId = crypto.randomBytes(16).toString('hex');
  const nowIso = new Date().toISOString();
  const spec = {
    jobId,
    engine,
    mode,
    output,
    deviceId: deviceId || null,
    sourceLang,
    targetLang,
    sourceFileName,
    glossaryCosKey,
    clientInfo,
    createdAt: nowIso,
  };
  const progress = { jobId, state: 'CREATED', percent: 0, engine, mode, output, updatedAt: nowIso };

  const jobKey = buildKey(`${jobId}/job.json`);
  const progressKey = buildKey(`${jobId}/progress.json`);
  const st1 = await cosPutJson({ bucket, region, key: jobKey, json: spec });
  const st2 = await cosPutJson({ bucket, region, key: progressKey, json: progress });
  if (st1 < 200 || st1 >= 300 || st2 < 200 || st2 >= 300) {
    return sendJson(res, 500, { error: 'CosWriteFailed' });
  }

  const sourceKey = buildKey(`${jobId}/source/source.epub`);
  const url = cosPresignUrl({
    method: 'PUT',
    bucket,
    region,
    key: sourceKey,
    expiresSeconds: presignSeconds,
    headers: { 'content-type': 'application/epub+zip' },
  });

  return sendJson(res, 200, {
    jobId,
    upload: { cosKey: sourceKey, url, method: 'PUT', contentType: 'application/epub+zip', expiresInSeconds: presignSeconds },
  });
}

async function handleMarkUploaded(res, body) {
  const { bucket, region } = getCosConfig();
  if (!bucket || !region) {
    return sendJson(res, 500, { error: 'ServerMisconfiguration', message: 'COS_BUCKET_NAME/BUCKET_NAME and COS_REGION/REGION must be set' });
  }
  const jobId = String(body.jobId || '').trim();
  if (!jobId) return sendJson(res, 400, { error: 'BadRequest', message: 'jobId required' });

  const progressKey = buildKey(`${jobId}/progress.json`);
  let progress;
  try {
    const buf = await cosGetObject({ bucket, region, key: progressKey });
    progress = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    return sendJson(res, 404, { error: 'NotFound', message: 'progress.json not found' });
  }
  progress.state = 'UPLOADED';
  progress.percent = Math.max(0, Number(progress.percent || 0));
  progress.updatedAt = new Date().toISOString();

  const st = await cosPutJson({ bucket, region, key: progressKey, json: progress });
  if (st < 200 || st >= 300) return sendJson(res, 500, { error: 'CosWriteFailed' });

  const queueKey = buildKey(`_queue/pending/${jobId}`);
  const qst = await cosPutObject({ bucket, region, key: queueKey, headers: {} });
  if (qst < 200 || qst >= 300) return sendJson(res, 500, { error: 'CosQueueFailed' });

  return sendJson(res, 200, { ok: true });
}

async function handleGetProgress(res, jobId) {
  const { bucket, region } = getCosConfig();
  if (!bucket || !region) {
    return sendJson(res, 500, { error: 'ServerMisconfiguration', message: 'COS_BUCKET_NAME/BUCKET_NAME and COS_REGION/REGION must be set' });
  }
  if (!jobId) return sendJson(res, 400, { error: 'BadRequest', message: 'jobId required' });
  const progressKey = buildKey(`${jobId}/progress.json`);
  try {
    const buf = await cosGetObject({ bucket, region, key: progressKey });
    return sendJson(res, 200, JSON.parse(buf.toString('utf8')));
  } catch (e) {
    return sendJson(res, 404, { error: 'NotFound', message: 'progress.json not found' });
  }
}

async function handleGetDownloadUrl(res, jobId, output) {
  const { bucket, region, presignSeconds } = getCosConfig();
  if (!bucket || !region) {
    return sendJson(res, 500, { error: 'ServerMisconfiguration', message: 'COS_BUCKET_NAME/BUCKET_NAME and COS_REGION/REGION must be set' });
  }
  if (!jobId) return sendJson(res, 400, { error: 'BadRequest', message: 'jobId required' });

  const progressKey = buildKey(`${jobId}/progress.json`);
  let progress;
  try {
    const buf = await cosGetObject({ bucket, region, key: progressKey });
    progress = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    return sendJson(res, 404, { error: 'NotFound', message: 'progress.json not found' });
  }
  if (String(progress.state || '').toUpperCase() !== 'DONE') {
    return sendJson(res, 409, { error: 'NotReady', message: 'job not done' });
  }

  const o = normalizeOutput(output || progress.output);
  const cosKey = o === 'BILINGUAL' ? buildKey(`${jobId}/result/bilingual.epub`) : buildKey(`${jobId}/result/translated.epub`);
  const url = cosPresignUrl({ method: 'GET', bucket, region, key: cosKey, expiresSeconds: presignSeconds, headers: {} });
  return sendJson(res, 200, { cosKey, url, expiresInSeconds: presignSeconds });
}

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
  if (status < 200 || status >= 300) {
    throw new Error(`COS Put Points Error: ${status}`);
  }
  return next;
}

async function handleBalance(res, deviceId) {
  const { bucket, region } = getCosConfig();
  if (!bucket || !region) {
    return sendJson(res, 500, { error: 'ServerMisconfiguration', message: 'COS_BUCKET_NAME/BUCKET_NAME and COS_REGION/REGION must be set' });
  }
  if (!deviceId) return sendJson(res, 400, { error: 'BadRequest', message: 'deviceId required' });
  const balance = await readPointsBalance({ bucket, region, deviceId });
  return sendJson(res, 200, { deviceId, balance });
}

async function handleRedeem(res, body) {
  const { bucket, region } = getCosConfig();
  if (!bucket || !region) {
    return sendJson(res, 500, { error: 'ServerMisconfiguration', message: 'COS_BUCKET_NAME/BUCKET_NAME and COS_REGION/REGION must be set' });
  }
  const licenseCode = String(body.licenseCode || body.license_code || '').trim();
  const deviceId = String(body.deviceId || body.device_id || '').trim();
  if (!licenseCode) return sendJson(res, 400, { error: 'BadRequest', message: 'licenseCode required' });
  if (!deviceId) return sendJson(res, 400, { error: 'BadRequest', message: 'deviceId required' });

  const pubKeyB64 = String(process.env.LICENSE_PUBLIC_KEY || '').trim();
  let pointsIndex = null;
  if (pubKeyB64) {
    try {
      const raw = licenseCode;
      if (!raw.startsWith('P3')) throw new Error('Invalid version');
      const bytes = base64UrlDecode(raw.substring(2));
      const payloadLen = 5;
      const sigLen = 64;
      if (bytes.length !== payloadLen + sigLen) throw new Error('Invalid length');
      const payload = bytes.slice(0, payloadLen);
      const signature = bytes.slice(payloadLen);
      const publicKey = getEd25519PublicKey(pubKeyB64);
      const valid = verifyEd25519(payload, signature, publicKey);
      if (!valid) return sendJson(res, 403, { error: 'InvalidLicenseSignature' });
      pointsIndex = payload[0];
    } catch (e) {
      return sendJson(res, 400, { error: 'InvalidLicenseFormat', message: String(e && e.message ? e.message : e) });
    }
  }

  const codeHash = sha256Hex(licenseCode);
  const usedKey = buildKey(`_billing/used_keys/${codeHash}.json`);

  const headStatus = await cosHeadObject({ bucket, region, key: usedKey });
  if (headStatus === 200) {
    return sendJson(res, 409, { used: true, alreadyUsed: true, codeHash });
  }
  if (headStatus !== 404) {
    return sendJson(res, 500, { error: 'CosHeadFailed', statusCode: headStatus });
  }

  const putStatus = await cosPutObject({
    bucket,
    region,
    key: usedKey,
    headers: { 'x-cos-meta-device-id': deviceId, 'x-cos-meta-redeemed-at': new Date().toISOString() },
  });
  if (putStatus < 200 || putStatus >= 300) {
    return sendJson(res, 500, { error: 'CosWriteFailed', statusCode: putStatus });
  }

  const map = [50000, 100000, 200000, 500000, 1000000];
  const idx = pointsIndex == null ? 0 : Number(pointsIndex);
  const pointsAdded = idx >= 0 && idx < map.length ? map[idx] : 0;
  if (pointsAdded <= 0) return sendJson(res, 400, { error: 'UnsupportedPointsIndex' });

  const prev = await readPointsBalance({ bucket, region, deviceId });
  const balance = await writePointsBalance({ bucket, region, deviceId, balance: prev + pointsAdded });

  return sendJson(res, 200, { used: false, alreadyUsed: false, codeHash, pointsAdded, balance });
}

function resolveAction(req, pathname, body) {
  if (pathname === '/jobs/create') return 'CreateJob';
  if (pathname === '/jobs/markUploaded') return 'MarkUploaded';
  if (pathname === '/jobs/progress' || pathname === '/jobs/detail') return 'GetProgress';
  if (pathname === '/jobs/download') return 'GetDownloadUrl';
  if (pathname === '/billing/redeem') return 'Redeem';
  if (pathname === '/billing/balance') return 'Balance';
  if (pathname === '/worker/next') return 'WorkerNext';
  if (pathname === '/worker/job') return 'WorkerJob';
  if (pathname === '/worker/progress') return 'WorkerProgress';
  if (pathname === '/worker/billing') return 'WorkerBilling';
  if (pathname === '/worker/sourceUrl') return 'WorkerSourceUrl';
  if (pathname === '/worker/resultUrl') return 'WorkerResultUrl';
  if (pathname === '/worker/deduct') return 'WorkerDeduct';
  if (pathname === '/worker/object') return 'WorkerObject';

  const action = String((body && (body.action || body.Action)) || '').trim();
  if (action) return action;
  if (body && (body.license_code || body.licenseCode)) return 'Redeem';
  return '';
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization,accept');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
    res.end();
    return;
  }

  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname || '/';

  let body = {};
  if (req.method === 'POST' || req.method === 'PUT') {
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { error: 'InvalidJson', message: String(e && e.message ? e.message : e) });
      return;
    }
  }

  const action = resolveAction(req, pathname, body);

  try {
    if ((req.method === 'POST' && action === 'CreateJob') || (req.method === 'POST' && pathname === '/jobs/create')) {
      await handleCreateJob(res, body);
      return;
    }
    if (req.method === 'POST' && (action === 'MarkUploaded' || pathname === '/jobs/markUploaded')) {
      await handleMarkUploaded(res, body);
      return;
    }
    if (req.method === 'GET' && (action === 'GetProgress' || pathname === '/jobs/progress' || pathname === '/jobs/detail')) {
      await handleGetProgress(res, String(url.searchParams.get('jobId') || '').trim());
      return;
    }
    if (req.method === 'GET' && (action === 'GetDownloadUrl' || pathname === '/jobs/download')) {
      await handleGetDownloadUrl(res, String(url.searchParams.get('jobId') || '').trim(), url.searchParams.get('output'));
      return;
    }
    if (req.method === 'POST' && (action === 'Redeem' || pathname === '/billing/redeem')) {
      await handleRedeem(res, body);
      return;
    }
    if (req.method === 'GET' && (action === 'Balance' || pathname === '/billing/balance')) {
      await handleBalance(res, String(url.searchParams.get('deviceId') || '').trim());
      return;
    }
    if (req.method === 'GET' && action === 'WorkerNext') {
      await handleWorkerNext(req, res);
      return;
    }
    if (req.method === 'GET' && action === 'WorkerJob') {
      const jobId = String(url.searchParams.get('jobId') || '').trim();
      await handleWorkerGetJson(req, res, buildKey(`${jobId}/job.json`));
      return;
    }
    if (req.method === 'GET' && action === 'WorkerProgress') {
      const jobId = String(url.searchParams.get('jobId') || '').trim();
      await handleWorkerGetJson(req, res, buildKey(`${jobId}/progress.json`));
      return;
    }
    if (req.method === 'PUT' && action === 'WorkerProgress') {
      const jobId = String(url.searchParams.get('jobId') || '').trim();
      await handleWorkerPutJson(req, res, buildKey(`${jobId}/progress.json`), body);
      return;
    }
    if (req.method === 'GET' && action === 'WorkerBilling') {
      const jobId = String(url.searchParams.get('jobId') || '').trim();
      await handleWorkerGetJson(req, res, buildKey(`${jobId}/billing.json`));
      return;
    }
    if (req.method === 'PUT' && action === 'WorkerBilling') {
      const jobId = String(url.searchParams.get('jobId') || '').trim();
      await handleWorkerPutJson(req, res, buildKey(`${jobId}/billing.json`), body);
      return;
    }
    if (req.method === 'GET' && action === 'WorkerSourceUrl') {
      await handleWorkerSourceUrl(req, res, String(url.searchParams.get('jobId') || '').trim());
      return;
    }
    if (req.method === 'GET' && action === 'WorkerResultUrl') {
      await handleWorkerResultUrl(req, res, String(url.searchParams.get('jobId') || '').trim(), url.searchParams.get('output'));
      return;
    }
    if (req.method === 'POST' && action === 'WorkerDeduct') {
      await handleWorkerDeduct(req, res, body);
      return;
    }
    if (req.method === 'GET' && action === 'WorkerObject') {
      await handleWorkerGetObjectString(req, res, url.searchParams.get('cosKey'));
      return;
    }
  } catch (e) {
    sendJson(res, 500, { error: 'InternalError', message: String(e && e.message ? e.message : e) });
    return;
  }

  sendJson(res, 404, { error: 'NotFound' });
});

const port = process.env.PORT ? Number(process.env.PORT) : 9000;
server.listen(port);
