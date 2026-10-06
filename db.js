// Kết nối PostgreSQL + tạo bảng khi khởi động
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('\n  Thiếu biến DATABASE_URL (chuỗi kết nối PostgreSQL). Xem .env.example\n');
  process.exit(1);
}

// Mạng nội bộ Railway / máy local không cần SSL; kết nối qua Internet thì bật SSL
const noSsl = process.env.PGSSLMODE === 'disable' || /@(localhost|127\.0\.0\.1|[^/]*\.railway\.internal)[:/]/.test(url);
const pool = new Pool({ connectionString: url, ssl: noSsl ? false : { rejectUnauthorized: false }, max: 5 });

const KEEP_VERSIONS = 30;

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS images (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      data BYTEA NOT NULL,
      uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS content_versions (
      id SERIAL PRIMARY KEY,
      data JSONB NOT NULL,
      saved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Lần đầu: nạp nội dung mặc định từ content.json
  const { rows } = await pool.query('SELECT 1 FROM content_versions LIMIT 1');
  if (!rows.length) {
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'content.json'), 'utf8'));
    await pool.query('INSERT INTO content_versions (data) VALUES ($1)', [seed]);
    console.log('  Đã nạp nội dung mặc định từ content.json');
  }
}

async function getContent() {
  const { rows } = await pool.query('SELECT data FROM content_versions ORDER BY id DESC LIMIT 1');
  return rows[0]?.data;
}

// Mỗi lần lưu là một phiên bản mới; giữ lại 30 bản gần nhất để khôi phục khi cần
async function saveContent(data, userId) {
  await pool.query('INSERT INTO content_versions (data, saved_by) VALUES ($1, $2)', [data, userId]);
  await pool.query(
    'DELETE FROM content_versions WHERE id NOT IN (SELECT id FROM content_versions ORDER BY id DESC LIMIT $1)',
    [KEEP_VERSIONS]
  );
}

module.exports = { pool, migrate, getContent, saveContent };
