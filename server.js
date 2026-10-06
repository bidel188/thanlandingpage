// Server landing + admin, dữ liệu lưu trên PostgreSQL. Chạy: npm start (cần DATABASE_URL)
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const auth = require('./auth');

const PORT = process.env.PORT || 3000;
const MAX_IMAGE = 15 * 1024 * 1024;
const MAX_JSON = 2 * 1024 * 1024;
const page = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8');
const PAGES = { index: page('index.html'), admin: page('admin.html'), login: page('login.html') };

/* ---------- Helpers ---------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function send(res, code, body, headers = {}) {
  const isJson = !(typeof body === 'string' || Buffer.isBuffer(body));
  res.writeHead(code, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}
const redirect = (res, to) => { res.writeHead(302, { Location: to }); res.end(); };

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, `Dữ liệu quá lớn (tối đa ${Math.round(limit / 1048576)}MB)`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  try { return JSON.parse((await readBody(req, MAX_JSON)).toString('utf8')); }
  catch (e) { throw e instanceof HttpError ? e : new HttpError(400, 'JSON không hợp lệ'); }
}

const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https';
const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
const getCookie = (req, name) => (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === name)?.[1];
function sessionCookie(req, token, maxAge) {
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}

// Chống CSRF: request ghi phải có header riêng + Origin trùng với tên miền đang chạy
function checkCsrf(req) {
  if (req.headers['x-requested-with'] !== 'admin') throw new HttpError(403, 'Yêu cầu không hợp lệ');
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === host; } catch {}
    if (!ok) throw new HttpError(403, 'Yêu cầu không hợp lệ');
  }
}

async function requireUser(req) {
  const user = await auth.getSessionUser(getCookie(req, 'sid'));
  if (!user) throw new HttpError(401, 'Chưa đăng nhập hoặc phiên đã hết hạn');
  return user;
}

/* ---------- Nội dung (cache trong bộ nhớ, xoá khi lưu) ---------- */
let contentCache = null;
const getContent = async () => (contentCache ??= await db.getContent());

const escHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const LINE_SEPS = new RegExp('[' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
const jsonForScript = (o) => JSON.stringify(o).replace(/</g, '\\u003c').replace(LINE_SEPS, (c) => '\\u' + c.charCodeAt(0).toString(16));

// Nhúng sẵn nội dung vào HTML: trang hiện ngay, Google đọc được tiêu đề/mô tả
async function renderIndex() {
  const c = await getContent();
  return PAGES.index
    .replace('<title>Loading…</title>', `<title>${escHtml(c.seo?.title)}</title>`)
    .replace('<meta name="description" content="">', `<meta name="description" content="${escHtml(c.seo?.description)}">`)
    .replace('</head>', `<script>window.__CONTENT__=${jsonForScript(c)}</script>\n</head>`);
}

/* ---------- Ảnh: nhận diện theo nội dung file, không tin đuôi file ---------- */
function detectImage(buf) {
  const hex = buf.subarray(0, 12).toString('hex');
  if (hex.startsWith('89504e47')) return 'image/png';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('47494638')) return 'image/gif';
  if (hex.startsWith('52494646') && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (/^ftypavi[fs]$/.test(buf.subarray(4, 12).toString())) return 'image/avif';
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(buf.subarray(0, 2048).toString('utf8').replace(/^﻿/, ''))) return 'image/svg+xml';
  return null;
}

async function uploadImage(req, user) {
  const buf = await readBody(req, MAX_IMAGE);
  if (!buf.length) throw new HttpError(400, 'File rỗng');
  const mime = detectImage(buf);
  if (!mime) throw new HttpError(400, 'Chỉ nhận ảnh JPG, PNG, WebP, GIF, AVIF, SVG');
  let name = 'image';
  try { name = decodeURIComponent(req.headers['x-filename'] || 'image').slice(0, 120); } catch {}
  const { rows } = await db.pool.query(
    'INSERT INTO images (filename, mime, size, data, uploaded_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [name, mime, buf.length, buf, user.id]
  );
  return { url: `/img/${rows[0].id}` };
}

async function serveImage(res, id) {
  const { rows } = await db.pool.query('SELECT mime, data FROM images WHERE id = $1', [id]);
  if (!rows[0]) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  res.writeHead(200, {
    'Content-Type': rows[0].mime,
    'Content-Length': rows[0].data.length,
    'Cache-Control': 'public, max-age=31536000, immutable',
    // SVG có thể chứa script: chặn chạy khi mở trực tiếp
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  });
  res.end(rows[0].data);
}

/* ---------- Routes ---------- */
async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname, m = req.method;

  if (m === 'GET') {
    if (p === '/' || p === '/index.html') return send(res, 200, await renderIndex());
    if (p === '/login') return (await auth.getSessionUser(getCookie(req, 'sid'))) ? redirect(res, '/admin') : send(res, 200, PAGES.login);
    if (p === '/admin' || p === '/admin.html') return (await auth.getSessionUser(getCookie(req, 'sid'))) ? send(res, 200, PAGES.admin) : redirect(res, '/login');
    if (p === '/health') return send(res, 200, { ok: true });
    const img = p.match(/^\/img\/(\d{1,10})$/);
    if (img) return serveImage(res, +img[1]);
    if (p === '/api/content') return send(res, 200, await getContent());
    if (p === '/api/me') return send(res, 200, await requireUser(req));
    if (p === '/api/users') {
      await requireUser(req);
      const { rows } = await db.pool.query('SELECT id, username, created_at FROM users ORDER BY id');
      return send(res, 200, rows);
    }
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  }

  checkCsrf(req);

  if (m === 'POST' && p === '/api/login') {
    const ip = clientIp(req), wait = auth.loginBlocked(ip);
    if (wait) throw new HttpError(429, `Sai quá nhiều lần. Thử lại sau ${wait} phút.`);
    const { username, password } = await readJson(req);
    const user = await auth.checkLogin(username, password);
    if (!user) { auth.recordFail(ip); throw new HttpError(401, 'Sai tên đăng nhập hoặc mật khẩu'); }
    auth.clearFails(ip);
    const token = await auth.createSession(user.id);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token, 7 * 86400) });
  }
  if (m === 'POST' && p === '/api/logout') {
    await auth.deleteSession(getCookie(req, 'sid'));
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  const user = await requireUser(req);

  if (m === 'PUT' && p === '/api/content') {
    const data = await readJson(req);
    if (!data || typeof data !== 'object' || Array.isArray(data) || !data.hero || !data.footer) throw new HttpError(400, 'Nội dung không hợp lệ');
    await db.saveContent(data, user.id);
    contentCache = data;
    return send(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/upload') return send(res, 200, await uploadImage(req, user));
  if (m === 'POST' && p === '/api/users') {
    const { username, password } = await readJson(req);
    return send(res, 200, await auth.createUser(String(username || '').trim(), password));
  }
  const del = p.match(/^\/api\/users\/(\d+)$/);
  if (m === 'DELETE' && del) {
    if (+del[1] === user.id) throw new HttpError(400, 'Không thể tự xoá tài khoản đang đăng nhập');
    await db.pool.query('DELETE FROM users WHERE id = $1', [+del[1]]);
    return send(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/password') {
    const { current, next } = await readJson(req);
    await auth.changePassword(user.id, current, next);
    await auth.deleteOtherSessions(user.id, getCookie(req, 'sid'));
    return send(res, 200, { ok: true });
  }
  throw new HttpError(404, 'Not found');
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  try {
    await route(req, res);
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Lỗi máy chủ' });
  }
});

(async () => {
  await db.migrate();
  await auth.ensureFirstAdmin();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Landing: http://localhost:${PORT}/\n  Admin:   http://localhost:${PORT}/admin\n`);
  });
})().catch((e) => { console.error('Không khởi động được:', e.message); process.exit(1); });
