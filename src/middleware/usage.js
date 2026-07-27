const db = require('../db');

/** 'YYYY-MM' 형식의 현재 청구 기간 */
function currentPeriod(d) {
  const t = d || new Date();
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0');
}

/**
 * 사용량 상한 검사 — 이 서비스의 원가를 지키는 핵심 장치.
 *
 * 요금제에 포함된 횟수를 넘으면
 *   · overage_fee 가 0이면  → 차단 (더 이상 AI를 호출하지 않음)
 *   · overage_fee 가 있으면 → 초과 과금으로 허용하고 청구서에 반영
 *
 * 이 미들웨어가 없으면 통행이 잦은 현장 하나가 월 원가를 수십 배로 만듭니다.
 */
async function checkQuota(req, res, next) {
  try {
  const period = currentPeriod();
  const tenantId = req.tenant.id;

  const row = await db.one(
    `SELECT call_count FROM usage_monthly WHERE tenant_id = $1 AND period = $2`,
    [tenantId, period]
  );
  const used = row ? row.call_count : 0;
  const limit = req.plan.includedCalls;

  req.usage = { period, used, limit, overage: 0 };

  if (used < limit) return next();          // 여유 있음

  // 포함 횟수 초과
  if (req.plan.overageFee > 0) {
    req.usage.overage = used - limit + 1;
    return next();                          // 초과 과금하고 계속 제공
  }

  // 초과 과금이 없는 요금제 → 차단
  return res.status(429).json({
    error: '이번 달 분석 횟수를 모두 사용했습니다',
    used, limit, period,
    hint: '요금제를 올리거나 다음 달까지 기다려 주세요. 앱의 "AI 분석 최소 간격"을 늘리면 사용량이 줄어듭니다.',
  });
  } catch (e) {
    console.error('[사용량 확인] 오류:', e.message);
    return res.status(500).json({ error: '사용량 확인 중 오류가 발생했습니다: ' + e.message });
  }
}

/**
 * 분석 1건을 사용량에 기록한다. (분석 성공 후 호출)
 * UPSERT 로 원자적으로 증가시켜 동시 요청에도 정확하다.
 */
async function recordUsage(tenantId, costKrw, client) {
  const period = currentPeriod();
  const q = `
    INSERT INTO usage_monthly (tenant_id, period, call_count, cost_krw, updated_at)
    VALUES ($1, $2, 1, $3, now())
    ON CONFLICT (tenant_id, period)
    DO UPDATE SET call_count = usage_monthly.call_count + 1,
                  cost_krw   = usage_monthly.cost_krw + EXCLUDED.cost_krw,
                  updated_at = now()`;
  const params = [tenantId, period, costKrw || 0];
  if (client) return client.query(q, params);
  return db.query(q, params);
}

/** 이번 달 사용 현황 조회 */
async function getUsage(tenantId, period) {
  const p = period || currentPeriod();
  const row = await db.one(
    `SELECT u.call_count, u.cost_krw, p.included_calls, p.overage_fee, p.monthly_fee, p.name AS plan_name
       FROM tenants t
       JOIN plans p ON p.code = t.plan_code
       LEFT JOIN usage_monthly u ON u.tenant_id = t.id AND u.period = $2
      WHERE t.id = $1`,
    [tenantId, p]
  );
  if (!row) return null;
  const used = row.call_count || 0;
  const limit = row.included_calls;
  return {
    period: p,
    planName: row.plan_name,
    used, limit,
    remaining: Math.max(0, limit - used),
    percent: limit ? Math.min(100, Math.round((used / limit) * 100)) : 0,
    overageCalls: Math.max(0, used - limit),
    overageFee: Math.max(0, used - limit) * parseFloat(row.overage_fee || 0),
    apiCost: parseFloat(row.cost_krw || 0),
    monthlyFee: row.monthly_fee,
  };
}

module.exports = { checkQuota, recordUsage, getUsage, currentPeriod };
