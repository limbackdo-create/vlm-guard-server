const { Pool } = require('pg');
const { cfg } = require('./config');

// 클라우드 DB(Neon·Supabase·Render 등)는 대부분 SSL 접속을 요구합니다.
// 주소에 sslmode 가 있거나 로컬이 아니면 자동으로 SSL을 켭니다.
const url = cfg.databaseUrl || '';
const isLocal = /localhost|127\.0\.0\.1/.test(url);
const needSsl = !isLocal || /sslmode=require/.test(url);

const pool = new Pool({
  connectionString: cfg.databaseUrl,
  ssl: needSsl ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  // 클라우드 DB는 절전에서 깨어나는 데 몇 초 걸릴 수 있어 넉넉히 잡습니다.
  connectionTimeoutMillis: 15000,
});

pool.on('error', (err) => {
  console.error('[DB] 예상치 못한 연결 오류:', err.message);
});

async function query(text, params) {
  return pool.query(text, params);
}

async function one(text, params) {
  const r = await pool.query(text, params);
  return r.rows[0] || null;
}

async function many(text, params) {
  const r = await pool.query(text, params);
  return r.rows;
}

// 여러 쿼리를 하나의 트랜잭션으로 묶는다 (사용량 기록 등에 사용)
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, one, many, tx };
