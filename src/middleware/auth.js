const jwt = require('jsonwebtoken');
const { cfg } = require('../config');
const db = require('../db');

/**
 * 기기 인증 — 현장의 폰/웹캠 앱이 사용
 * 앱은 헤더에 X-Device-Key 를 담아 보낸다.
 * 성공하면 req.device, req.tenant, req.plan 이 채워진다.
 */
async function deviceAuth(req, res, next) {
  const key = req.get('X-Device-Key');
  if (!key) {
    return res.status(401).json({ error: '기기 키가 없습니다 (X-Device-Key 헤더 필요)' });
  }

  const row = await db.one(
    `SELECT d.id AS device_id, d.name AS device_name, d.site_id, d.status AS device_status,
            t.id AS tenant_id, t.name AS tenant_name, t.status AS tenant_status,
            t.plan_code, t.phone, t.email,
            t.notify_kakao, t.notify_sms, t.notify_email,
            p.included_calls, p.overage_fee, p.monthly_fee
       FROM devices d
       JOIN tenants t ON t.id = d.tenant_id
       JOIN plans   p ON p.code = t.plan_code
      WHERE d.device_key = $1`,
    [key]
  );

  if (!row) return res.status(401).json({ error: '등록되지 않은 기기입니다' });
  if (row.device_status !== 'active') return res.status(403).json({ error: '사용 중지된 기기입니다' });
  if (row.tenant_status !== 'active') {
    return res.status(403).json({ error: '계정이 정지되었습니다. 결제 상태를 확인하세요' });
  }

  req.device = { id: row.device_id, name: row.device_name, siteId: row.site_id };
  req.tenant = {
    id: row.tenant_id, name: row.tenant_name, planCode: row.plan_code,
    phone: row.phone, email: row.email,
    notify: { kakao: row.notify_kakao, sms: row.notify_sms, email: row.notify_email },
  };
  req.plan = {
    code: row.plan_code, includedCalls: row.included_calls,
    overageFee: parseFloat(row.overage_fee), monthlyFee: row.monthly_fee,
  };

  // 마지막 접속 시각 갱신 (실패해도 요청은 진행)
  db.query('UPDATE devices SET last_seen_at = now() WHERE id = $1', [row.device_id])
    .catch(() => {});

  next();
}

/**
 * 관리자 인증 — 대시보드에서 사용 (JWT)
 */
function adminAuth(req, res, next) {
  const h = req.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: '로그인이 필요합니다' });

  try {
    const payload = jwt.verify(token, cfg.jwtSecret);
    req.auth = payload;   // { tenantId, email }
    next();
  } catch (e) {
    return res.status(401).json({ error: '로그인이 만료되었습니다. 다시 로그인하세요' });
  }
}

function issueToken(tenant) {
  return jwt.sign(
    { tenantId: tenant.id, email: tenant.email, name: tenant.name },
    cfg.jwtSecret,
    { expiresIn: '12h' }
  );
}

module.exports = { deviceAuth, adminAuth, issueToken };
