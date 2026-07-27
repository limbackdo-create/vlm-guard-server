const fs = require('fs');
const path = require('path');
const db = require('./db');

/**
 * 서버가 켜질 때 필요한 테이블이 없으면 자동으로 만든다.
 * psql 명령을 몰라도 되도록 하기 위한 장치.
 * schema.sql 은 모두 IF NOT EXISTS 라서 여러 번 실행해도 안전하다.
 */
async function autoMigrate() {
  try {
    const exists = await db.one(
      `SELECT to_regclass('public.tenants') IS NOT NULL AS ok`
    );
    if (exists && exists.ok) {
      console.log('[DB] 테이블 확인 완료');
      return { created: false };
    }

    console.log('[DB] 테이블이 없어 새로 만듭니다...');
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    await db.query(sql);
    console.log('[DB] 테이블 생성 완료');
    return { created: true };
  } catch (e) {
    console.error('[DB] 초기화 실패:', e.message);
    console.error('     DATABASE_URL 이 올바른지 확인하세요.');
    throw e;
  }
}

module.exports = { autoMigrate };
