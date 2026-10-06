// Server nhỏ cho landing + admin. Không cần cài thư viện: chạy `node server.js`.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const CONTENT = path.join(ROOT, 'content.json');
const UPLOADS = path.join(ROOT, 'uploads');
const BACKUPS = path.join(ROOT, 'backups');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.ico': 'image/x-icon',
};
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif'];
const MAX_BODY = 20 * 1024 * 1024;

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('File quá lớn (tối đa 20MB)')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function saveContent(req, res) {
  const data = JSON.parse(await readBody(req));
  fs.mkdirSync(BACKUPS, { recursive: true });
  if (fs.existsSync(CONTENT)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(CONTENT, path.join(BACKUPS, `content-${stamp}.json`));
    // Giữ 30 bản sao lưu gần nhất
    const old = fs.readdirSync(BACKUPS).filter((f) => f.endsWith('.json')).sort().slice(0, -30);
    old.forEach((f) => fs.unlinkSync(path.join(BACKUPS, f)));
  }
  fs.writeFileSync(CONTENT, JSON.stringify(data, null, 2));
  send(res, 200, { ok: true });
}

async function upload(req, res) {
  const { name = 'image.png', data = '' } = JSON.parse(await readBody(req));
  const ext = path.extname(name).toLowerCase();
  if (!IMAGE_EXT.includes(ext)) return send(res, 400, { error: 'Chỉ nhận file ảnh: ' + IMAGE_EXT.join(', ') });
  const base64 = data.split(',').pop();
  const safe = path.basename(name, ext).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'image';
  const file = `${Date.now()}-${safe}${ext}`;
  fs.mkdirSync(UPLOADS, { recursive: true });
  fs.writeFileSync(path.join(UPLOADS, file), Buffer.from(base64, 'base64'));
  send(res, 200, { url: `uploads/${file}` });
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath === '/admin') urlPath = '/admin.html';
  const file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT + path.sep) || /[\\/](backups|node_modules)[\\/]/.test(file)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, buf, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
}

// Chỉ chấp nhận truy cập qua localhost (chặn DNS rebinding)
const ALLOWED_HOSTS = [`localhost:${PORT}`, `127.0.0.1:${PORT}`];
// Thao tác ghi phải đến từ chính trang admin, dạng JSON (chặn web lạ gửi lén - CSRF)
function isTrustedWrite(req) {
  const origin = req.headers.origin;
  const originOk = !origin || ALLOWED_HOSTS.some((h) => origin === `http://${h}`);
  const jsonOk = (req.headers['content-type'] || '').startsWith('application/json');
  return originOk && jsonOk;
}

const server = http.createServer(async (req, res) => {
  try {
    if (!ALLOWED_HOSTS.includes(req.headers.host)) return send(res, 403, 'Forbidden', 'text/plain');
    if (req.method === 'POST' && !isTrustedWrite(req)) return send(res, 403, { error: 'Yêu cầu không hợp lệ' });
    if (req.method === 'POST' && req.url === '/api/content') return await saveContent(req, res);
    if (req.method === 'POST' && req.url === '/api/upload') return await upload(req, res);
    if (req.method === 'GET') return serveStatic(req, res);
    send(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

// Chỉ nghe trên máy local, vì trang admin không có đăng nhập
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}/admin`;
  console.log(`\n  Landing: http://localhost:${PORT}/\n  Admin:   ${url}\n\n  (Nhấn Ctrl+C để tắt)\n`);
  if (!process.argv.includes('--no-open')) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd);
  }
});
