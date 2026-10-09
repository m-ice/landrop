#!/usr/bin/env node
'use strict';
/**
 * 邻传 · LAN Drop — Node.js 22/24+, zero npm dependencies.
 * Local disk relay, NOT peer-to-peer. HTTP is intended for a trusted LAN only.
 * Run: node server.js
 * See README.md for storage, access-code, firewall, and deployment details.
 */
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const ROOT = __dirname;
const PORT = positiveNumber('PORT', 8080, 65535);
const HOST = process.env.HOST || '0.0.0.0';
const QUOTA = Math.floor(positiveNumber('MAX_TOTAL_GB', 20, 1024 * 1024) * 1024 ** 3);
const TTL_MS = positiveNumber('TTL_HOURS', 24, 8760) * 3600000;
const CHUNK_BYTES = 4 * 1024 * 1024;
const ONLINE_MS = 25000;
const SESSION_MS = 48 * 3600000;
const ACCESS_CODE = process.env.ACCESS_CODE || String(crypto.randomInt(10000000, 100000000));
if (!/^[\x21-\x7e]{8,128}$/.test(ACCESS_CODE)) {
  throw new Error('ACCESS_CODE 必须为 8–128 个非空格 ASCII 字符。');
}
const DATA_ROOT = path.resolve(process.env.DATA_DIR || path.join(ROOT, '.landrop-data'));
// Each process owns its own temporary directory. Interrupted runs are not silently deleted.
const RUN_DIR = path.join(DATA_ROOT, `run-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
const sessions = new Map();
const transfers = new Map();
const attempts = new Map();
const localIPs = [...new Set(Object.values(os.networkInterfaces()).flat()
  .filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address))];
const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', ...localIPs,
  ...(process.env.ALLOWED_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)]);
if (HOST !== '0.0.0.0' && HOST !== '::') allowedHosts.add(HOST.toLowerCase());
let server;
let closing = false;

function positiveNumber(name, fallback, max) {
  const n = Number(process.env[name] || fallback);
  if (!Number.isFinite(n) || n <= 0 || n > max || (name === 'PORT' && !Number.isInteger(n))) {
    throw new Error(`${name} 参数无效。`);
  }
  return n;
}
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function assert(condition, status, message) { if (!condition) throw new HttpError(status, message); }
function digest(value) { return crypto.createHash('sha256').update(value).digest(); }
function json(res, status, value, extra = {}) {
  if (res.destroyed || res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, ...extra });
  res.end(body);
}
function securityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}
function checkHostAndOrigin(req) {
  let host;
  try { host = new URL(`http://${req.headers.host}`).hostname.toLowerCase(); }
  catch { throw new HttpError(400, 'Host 无效。'); }
  assert(allowedHosts.has(host), 403, '该主机名未获允许。请使用控制台打印的局域网 IP，或配置 ALLOWED_HOSTS。');
  if (req.headers.origin) {
    let origin;
    try { origin = new URL(req.headers.origin); } catch { throw new HttpError(403, '不允许跨站访问。'); }
    assert(['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host, 403, '不允许跨站访问。');
  }
  assert(!['cross-site'].includes(req.headers['sec-fetch-site']), 403, '不允许跨站访问。');
  if (!['GET', 'HEAD'].includes(req.method)) {
    assert(req.headers['x-landrop'] === '1', 403, '缺少同源请求标识。');
  }
}
function getSession(req, required = true) {
  const cookie = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('landrop='));
  const token = cookie ? cookie.slice('landrop='.length) : '';
  const key = token ? digest(token).toString('hex') : '';
  const s = sessions.get(key);
  if (!s || s.expiresAt < Date.now()) {
    if (s) sessions.delete(key);
    if (required) throw new HttpError(401, '请先输入访问码加入。服务重启后需要重新加入。');
    return null;
  }
  s.lastSeen = Date.now();
  return s;
}
function cleanText(value, max = 40) {
  return String(value || '').toWellFormed().replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, max);
}
function cleanFilename(value) {
  let name = cleanText(value, 1024).replace(/\\/g, '/').split('/').pop().replace(/[<>:"|?*]/g, '_').replace(/[ .]+$/g, '');
  if (!name || name === '.' || name === '..') name = 'unnamed-file';
  while (Buffer.byteLength(name, 'utf8') > 220) name = Array.from(name).slice(0, -1).join('');
  return name;
}
async function readJson(req) {
  assert((req.headers['content-type'] || '').split(';')[0].trim() === 'application/json', 415, '需要 JSON 请求。');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    assert(size <= 16384, 413, '请求内容过大。');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert(value && typeof value === 'object' && !Array.isArray(value), 400, 'JSON 必须为对象。');
    return value;
  } catch { throw new HttpError(400, 'JSON 格式无效，请提供对象。'); }
}
function reservedBytes() { return [...transfers.values()].reduce((sum, t) => sum + t.size, 0); }
function canRead(s, t) { return t.senderId === s.id || t.receiverId === '*' || t.receiverId === s.id; }
function viewTransfer(t) {
  return { id: t.id, name: t.name, size: t.size, received: t.received, status: t.status,
    senderId: t.senderId, senderName: t.senderName, receiverId: t.receiverId,
    receiverName: t.receiverName, createdAt: t.createdAt, updatedAt: t.updatedAt,
    expiresAt: t.updatedAt + TTL_MS };
}
function stateFor(s) {
  const now = Date.now();
  return {
    me: { id: s.id, name: s.name, kind: s.kind },
    devices: [...sessions.values()].filter(d => d.id !== s.id && now - d.lastSeen < ONLINE_MS)
      .map(d => ({ id: d.id, name: d.name, kind: d.kind })),
    transfers: [...transfers.values()].filter(t => canRead(s, t)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 250).map(viewTransfer),
    server: { urls: (HOST === '127.0.0.1' || HOST === 'localhost' ? ['127.0.0.1'] : localIPs).map(ip => `http://${ip}:${PORT}`),
      quotaBytes: QUOTA, reservedBytes: reservedBytes(), ttlHours: TTL_MS / 3600000, chunkBytes: CHUNK_BYTES },
  };
}
function transferFor(s, id) {
  const t = transfers.get(id);
  assert(t && canRead(s, t), 404, '文件不存在、已过期，或你无权访问。');
  return t;
}
async function removeTransfer(t) {
  transfers.delete(t.id);
  t.deleted = true;
  if (t.activeReq) t.activeReq.destroy(new Error('Transfer cancelled'));
  if (!t.busy) await fsp.rm(t.file, { force: true });
}
async function acceptChunk(req, res, s, id, offsetText) {
  const t = transferFor(s, id);
  assert(t.senderId === s.id, 403, '只有发送方能上传。');
  assert(t.status === 'uploading' && !t.busy, 409, '文件已完成或有分块正在写入，请稍后重试。');
  const offset = Number(offsetText);
  const lengthText = req.headers['content-length'];
  const length = Number(lengthText);
  assert(offsetText !== null && Number.isSafeInteger(offset) && offset >= 0, 400, '分块偏移无效。');
  assert(offset === t.received, 409, '分块偏移不一致，请同步进度后重试。');
  assert(lengthText !== undefined && /^\d+$/.test(lengthText) && Number.isSafeInteger(length) && length >= 0, 411, '需要有效的 Content-Length。');
  assert(length <= CHUNK_BYTES && offset + length <= t.size && (length > 0 || t.size === 0), 413, '分块大小无效。');
  t.busy = true;
  t.activeReq = req;
  let written = 0;
  const counter = new Transform({ transform(chunk, encoding, callback) {
    written += chunk.length;
    if (written > length) callback(new Error('Chunk too large'));
    else callback(null, chunk);
  }});
  try {
    await pipeline(req, counter, fs.createWriteStream(t.file, { flags: 'r+', start: offset }));
    assert(written === length, 400, '分块长度不符。');
    if (t.deleted) return;
    t.received += written;
    t.updatedAt = Date.now();
    if (t.received === t.size) t.status = 'ready';
    json(res, 200, viewTransfer(t));
  } catch (err) {
    // A partial/aborted chunk never advances the committed offset.
    if (!t.deleted) {
      try { await fsp.truncate(t.file, offset); }
      catch { await removeTransfer(t); }
    }
    if (!res.destroyed && !res.headersSent) json(res, err.status || 500, { error: '分块写入失败；请检查磁盘空间并重试。' });
  } finally {
    t.busy = false;
    t.activeReq = null;
    if (t.deleted) await fsp.rm(t.file, { force: true }).catch(() => {});
  }
}
function parseRange(value, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(value || '');
  assert(m && (m[1] || m[2]) && size > 0, 416, '下载范围无效。');
  let start, end;
  if (!m[1]) {
    const suffix = Number(m[2]);
    assert(Number.isSafeInteger(suffix) && suffix > 0, 416, '下载范围无效。');
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(m[1]); end = m[2] ? Number(m[2]) : size - 1;
    assert(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start < size && end >= start, 416, '下载范围无效。');
    end = Math.min(end, size - 1);
  }
  return { start, end };
}
async function download(req, res, s, id) {
  const t = transferFor(s, id);
  assert(t.status === 'ready', 409, '文件尚未发送完成。');
  const stat = await fsp.stat(t.file).catch(() => null);
  assert(stat && stat.size === t.size, 410, '主机缓存文件已被移除或损坏，请重新发送。');
  const etag = `"${t.id}-${t.size}"`;
  let start = 0, end = t.size - 1, code = 200;
  if (req.headers.range && (!req.headers['if-range'] || req.headers['if-range'] === etag)) {
    try { ({ start, end } = parseRange(req.headers.range, t.size)); code = 206; }
    catch (err) { res.setHeader('Content-Range', `bytes */${t.size}`); throw err; }
  }
  const filename = encodeURIComponent(t.name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${filename}`,
    'Content-Length': Math.max(0, end - start + 1),
    'Accept-Ranges': 'bytes', 'ETag': etag,
    'Content-Security-Policy': "default-src 'none'; sandbox",
  };
  if (code === 206) headers['Content-Range'] = `bytes ${start}-${end}/${t.size}`;
  res.writeHead(code, headers);
  if (req.method === 'HEAD' || t.size === 0) { res.end(); return; }
  try { await pipeline(fs.createReadStream(t.file, { start, end }), res); }
  catch (err) { if (!['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET'].includes(err.code)) console.warn('下载中断:', err.message); }
}
async function route(req, res) {
  securityHeaders(res);
  checkHostAndOrigin(req);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;
  if ((url.pathname === '/' || url.pathname === '/index.html') && ['GET', 'HEAD'].includes(method)) {
    const page = await fsp.readFile(path.join(ROOT, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': page.length });
    res.end(method === 'HEAD' ? undefined : page); return;
  }
  if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (url.pathname === '/api/health' && method === 'GET') { json(res, 200, { ok: true, app: 'landrop' }); return; }
  if (url.pathname === '/api/join' && method === 'POST') {
    const ip = req.socket.remoteAddress;
    const now = Date.now();
    let limit = attempts.get(ip);
    if (!limit || now - limit.since > 15 * 60000) {
      limit = { since: now, count: 0 }; attempts.set(ip, limit);
    }
    assert(limit.count < 12, 429, '访问码错误次数过多，请 15 分钟后再试。');
    const body = await readJson(req);
    if (!crypto.timingSafeEqual(digest(String(body.code || '')), digest(ACCESS_CODE))) {
      limit.count++; throw new HttpError(403, '访问码不正确，请查看运行服务的电脑控制台。');
    }
    limit.count = 0;
    const name = cleanText(body.name);
    assert(name, 400, '请输入设备名称。');
    const old = getSession(req, false);
    const token = crypto.randomBytes(32).toString('base64url');
    const s = old || { id: crypto.randomUUID() };
    Object.assign(s, { name, kind: ['phone', 'tablet', 'desktop'].includes(body.kind) ? body.kind : 'desktop', lastSeen: now, expiresAt: now + SESSION_MS });
    assert(old || sessions.size < 128, 503, '设备会话已满，请稍后再试。');
    // Replace the old credential, preserving this browser's device identity.
    if (old) for (const [key, entry] of sessions) if (entry === old) sessions.delete(key);
    sessions.set(digest(token).toString('hex'), s);
    json(res, 200, stateFor(s), { 'Set-Cookie': `landrop=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${SESSION_MS / 1000}` });
    return;
  }
  const s = getSession(req);
  if (url.pathname === '/api/state' && method === 'GET') { json(res, 200, stateFor(s)); return; }
  if (url.pathname === '/api/me' && method === 'PATCH') {
    const body = await readJson(req); const name = cleanText(body.name);
    assert(name, 400, '设备名称不能为空。'); s.name = name;
    json(res, 200, { id: s.id, name: s.name, kind: s.kind }); return;
  }
  if (url.pathname === '/api/transfers' && method === 'POST') {
    const body = await readJson(req);
    assert(typeof body.name === 'string' && body.name.length > 0, 400, '文件名无效。');
    assert(Number.isSafeInteger(body.size) && body.size >= 0, 400, '文件大小无效。');
    assert(transfers.size < 1000, 429, '缓存文件过多，请删除不再需要的文件。');
    assert(reservedBytes() + body.size <= QUOTA, 507, '主机缓存配额不足，请清理文件或调大 MAX_TOTAL_GB。');
    let receiver = null;
    if (body.receiverId !== '*') {
      receiver = [...sessions.values()].find(x => x.id === body.receiverId && Date.now() - x.lastSeen < ONLINE_MS);
      assert(receiver && receiver.id !== s.id, 409, '接收设备已离线，请刷新设备列表。');
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    const t = { id, name: cleanFilename(body.name), size: body.size, received: 0, status: 'uploading',
      senderId: s.id, senderName: s.name, receiverId: receiver ? receiver.id : '*',
      receiverName: receiver ? receiver.name : '所有已加入设备', createdAt: now, updatedAt: now,
      file: path.join(RUN_DIR, id), busy: false, deleted: false };
    // Reserve quota synchronously before yielding to disk I/O.
    transfers.set(id, t);
    try { await fsp.writeFile(t.file, Buffer.alloc(0), { flag: 'wx', mode: 0o600 }); }
    catch { transfers.delete(id); throw new HttpError(507, '无法创建缓存文件，请检查磁盘权限和剩余空间。'); }
    json(res, 201, viewTransfer(t)); return;
  }
  let match = /^\/api\/transfers\/([a-f0-9-]{36})$/.exec(url.pathname);
  if (match && method === 'GET') { json(res, 200, viewTransfer(transferFor(s, match[1]))); return; }
  if (match && method === 'DELETE') {
    const t = transferFor(s, match[1]);
    assert(t.senderId === s.id || t.receiverId === s.id, 403, '共享文件只能由发送者删除。');
    await removeTransfer(t); json(res, 200, { ok: true }); return;
  }
  match = /^\/api\/transfers\/([a-f0-9-]{36})\/chunk$/.exec(url.pathname);
  if (match && method === 'PUT') { await acceptChunk(req, res, s, match[1], url.searchParams.get('offset')); return; }
  match = /^\/api\/files\/([a-f0-9-]{36})$/.exec(url.pathname);
  if (match && ['GET', 'HEAD'].includes(method)) { await download(req, res, s, match[1]); return; }
  throw new HttpError(404, '接口不存在。');
}

async function main() {
  await fsp.mkdir(RUN_DIR, { recursive: true, mode: 0o700 });
  const previous = (await fsp.readdir(DATA_ROOT)).filter(n => n.startsWith('run-') && n !== path.basename(RUN_DIR));
  if (previous.length) console.warn(`注意：${DATA_ROOT} 中有 ${previous.length} 个旧运行目录。确认没有其他实例后可手动删除；旧缓存不计入本次配额。`);
  server = http.createServer((req, res) => {
    route(req, res).catch(err => {
      if (err.status !== 401 && (!err.status || err.status >= 500)) console.error(err.message);
      if (!res.headersSent) json(res, err.status || 500, { error: err.status ? err.message : '主机内部错误，请查看控制台。' });
      else if (!res.destroyed) res.destroy();
    });
  });
  // A bounded 4 MiB chunk gets up to five minutes; downloads are streamed.
  server.requestTimeout = 5 * 60000;
  server.headersTimeout = 60000;
  server.keepAliveTimeout = 10000;
  server.maxHeadersCount = 80;
  server.on('error', err => { console.error(`启动失败: ${err.message}`); process.exitCode = 1; });
  server.listen(PORT, HOST, () => {
    console.log('\n  邻传 LAN DROP  ·  局域网文件中转\n');
    console.log(`  本机访问:  http://localhost:${PORT}`);
    if (HOST === '127.0.0.1' || HOST === 'localhost') console.log('  当前仅监听本机，其他设备无法访问。');
    else for (const ip of localIPs) console.log(`  局域网:    http://${ip}:${PORT}`);
    console.log(`\n  访问码:    ${ACCESS_CODE}`);
    console.log(`  缓存配额:  ${(QUOTA / 1024 ** 3).toFixed(2)} GiB（预留文件总大小）`);
    console.log(`  自动过期:  ${TTL_MS / 3600000} 小时无上传活动`);
    console.log(`  缓存目录:  ${RUN_DIR}`);
    console.log('\n  其他设备连接同一局域网，打开上面的局域网地址并输入访问码。');
    console.log('  HTTP 未加密，仅用于可信局域网；请勿向公网开放端口。');
    console.log('  Ctrl+C 停止，正常退出将删除本次缓存。\n');
  });
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const t of transfers.values()) if (!t.busy && now - t.updatedAt > TTL_MS) removeTransfer(t).catch(console.error);
    for (const [key, s] of sessions) if (s.expiresAt < now) sessions.delete(key);
    for (const [key, value] of attempts) if (now - value.since > 15 * 60000) attempts.delete(key);
  }, 60000);
  cleanup.unref();
  async function shutdown() {
    if (closing) return; closing = true;
    clearInterval(cleanup);
    console.log('\n正在停止服务并清理本次缓存…');
    server.close(); server.closeAllConnections();
    const activeTransfers = [...transfers.values()];
    for (const t of activeTransfers) await removeTransfer(t).catch(() => {});
    // Let aborted pipelines close their file handles before recursive removal (Windows).
    const started = Date.now();
    while (activeTransfers.some(t => t.busy) && Date.now() - started < 3000) {
      await new Promise(r => setTimeout(r, 50));
    }
    await fsp.rm(RUN_DIR, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }).catch(err => console.error('请手动清理缓存:', err.message));
    process.exit(0);
  }
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
main().catch(err => { console.error(err.message); process.exitCode = 1; });
