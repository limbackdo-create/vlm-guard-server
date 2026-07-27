/**
 * 테스트용 초기 데이터 생성
 * 실행: node scripts/seed.js
 */
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../src/db');

(async () => {
  const hash = await bcrypt.hash('test1234', 10);
  const t = await db.one(
    `INSERT INTO tenants (name, email, password_hash, phone, plan_code)
     VALUES ('테스트 매장','test@example.com',$1,'01000000000','standard')
     ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [hash]);

  const s = await db.one(
    `INSERT INTO sites (tenant_id, name, knowledge, rules, targets)
     VALUES ($1,'1층 출입구',
       '직원은 검은색 유니폼을 입는다\n가게에 고양이 한 마리가 있다',
       '[{"from":22,"to":6,"text":"이 시간엔 출입이 없어야 함"}]'::jsonb,
       '["수상한 행동을 하는 사람","침입·무단 출입","연기·불"]'::jsonb)
     RETURNING id`, [t.id]);

  const key = 'dev_' + crypto.randomBytes(24).toString('hex');
  await db.query(
    `INSERT INTO devices (tenant_id, site_id, name, device_key, detect_mode)
     VALUES ($1,$2,'출입구 구형폰',$3,'door')`, [t.id, s.id, key]);

  console.log('테스트 계정 생성 완료');
  console.log('  로그인: test@example.com / test1234');
  console.log('  기기 키:', key);
  await db.pool.end();
})();
