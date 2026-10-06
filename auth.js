// Tài khoản, mật khẩu, phiên đăng nhập
const crypto = require('crypto');
const { promisify } = require('util');
const { pool } = require('./db');

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 7;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const MIN_PASSWORD = 8;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [algo, salt, hash] = String(stored).split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(actual, expected);
}

// Hash giả để so sánh khi username không tồn tại, tránh lộ qua thời gian phản hồi
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

function validateCredentials(username, password) {
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username || '')) return 'Tên đăng nhập 3–32 ký tự, chỉ gồm chữ không dấu, số, . _ -';
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return `Mật khẩu tối thiểu ${MIN_PASSWORD} ký tự`;
  if (password.length > 200) return 'Mật khẩu quá dài';
  return null;
}

async function createUser(username, password) {
  const err = validateCredentials(username, password);
  if (err) throw Object.assign(new Error(err), { status: 400 });
  try {
    const { rows } = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username, created_at',
      [username, await hashPassword(password)]
    );
    return rows[0];
  } catch (e) {
    if (e.code === '23505') throw Object.assign(new Error('Tên đăng nhập đã tồn tại'), { status: 400 });
    throw e;
  }
}

async function checkLogin(username, password) {
  const { rows } = await pool.query('SELECT id, username, password_hash FROM users WHERE username = $1', [String(username || '')]);
  const user = rows[0];
  const ok = await verifyPassword(String(password || ''), user ? user.password_hash : await DUMMY_HASH);
  return ok && user ? { id: user.id, username: user.username } : null;
}

async function changePassword(userId, current, next) {
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (!rows[0] || !(await verifyPassword(String(current || ''), rows[0].password_hash))) {
    throw Object.assign(new Error('Mật khẩu hiện tại không đúng'), { status: 400 });
  }
  const err = validateCredentials('placeholder', next);
  if (err) throw Object.assign(new Error(err), { status: 400 });
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(next), userId]);
}

/* ---------- Phiên đăng nhập: chỉ lưu hash của token trong DB ---------- */
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query('DELETE FROM sessions WHERE expires_at < now()');
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`,
    [sha256(token), userId]
  );
  return token;
}

async function getSessionUser(token) {
  if (!token) return null;
  const { rows } = await pool.query(
    'SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()',
    [sha256(token)]
  );
  return rows[0] || null;
}

const deleteSession = (token) => token && pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
const deleteOtherSessions = (userId, keepToken) =>
  pool.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [userId, sha256(keepToken)]);

/* ---------- Chống dò mật khẩu: tối đa 10 lần sai / 15 phút / IP ---------- */
const attempts = new Map();
const WINDOW = 15 * 60 * 1000, MAX_FAILS = 10;
function loginBlocked(ip) {
  const a = attempts.get(ip);
  if (!a || Date.now() - a.first > WINDOW) return 0;
  return a.count >= MAX_FAILS ? Math.ceil((a.first + WINDOW - Date.now()) / 60000) : 0;
}
function recordFail(ip) {
  const a = attempts.get(ip);
  if (!a || Date.now() - a.first > WINDOW) attempts.set(ip, { first: Date.now(), count: 1 });
  else a.count++;
  if (attempts.size > 10000) attempts.clear();
}
const clearFails = (ip) => attempts.delete(ip);

// Tạo tài khoản đầu tiên từ biến môi trường ADMIN_USERNAME / ADMIN_PASSWORD
async function ensureFirstAdmin() {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
  if (rows[0].n > 0) return;
  const { ADMIN_USERNAME: u, ADMIN_PASSWORD: p } = process.env;
  if (!u || !p) {
    console.warn('  ⚠ Chưa có tài khoản admin. Đặt biến ADMIN_USERNAME và ADMIN_PASSWORD rồi khởi động lại.');
    return;
  }
  await createUser(u, p);
  console.log(`  Đã tạo tài khoản admin đầu tiên: ${u}`);
}

module.exports = {
  createUser, checkLogin, changePassword, createSession, getSessionUser, deleteSession, deleteOtherSessions,
  loginBlocked, recordFail, clearFails, ensureFirstAdmin,
};
