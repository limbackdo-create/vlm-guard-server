const { cfg } = require('../config');
const db = require('../db');
const { currentPeriod } = require('../middleware/usage');

/**
 * 구독·결제 모듈
 *
 * PG사(토스페이먼츠·아임포트 등)와 계약 후 .env 에 키를 넣으면 실제 결제가 동작합니다.
 * 계약 전에는 청구서만 생성되고 결제는 'pending' 상태로 남습니다.
 */

/** 지난달(또는 지정 기간) 청구서를 만든다 */
async function generateInvoice(tenantId, period) {
  const p = period || previousPeriod();

  const row = await db.one(
    `SELECT t.id, t.name, p.code AS plan_code, p.monthly_fee, p.included_calls, p.overage_fee,
            COALESCE(u.call_count,0) AS used, COALESCE(u.cost_krw,0) AS api_cost
       FROM tenants t
       JOIN plans p ON p.code = t.plan_code
       LEFT JOIN usage_monthly u ON u.tenant_id = t.id AND u.period = $2
      WHERE t.id = $1`,
    [tenantId, p]
  );
  if (!row) throw new Error('고객을 찾을 수 없습니다');

  const used = Number(row.used);
  const overageCalls = Math.max(0, used - row.included_calls);
  const overageFee = Math.round(overageCalls * parseFloat(row.overage_fee));
  const total = row.monthly_fee + overageFee;

  const inv = await db.one(
    `INSERT INTO invoices (tenant_id, period, base_fee, overage_calls, overage_fee, total_fee, status)
     VALUES ($1,$2,$3,$4,$5,$6,'pending')
     ON CONFLICT (tenant_id, period)
     DO UPDATE SET base_fee=EXCLUDED.base_fee, overage_calls=EXCLUDED.overage_calls,
                   overage_fee=EXCLUDED.overage_fee, total_fee=EXCLUDED.total_fee
     RETURNING *`,
    [tenantId, p, row.monthly_fee, overageCalls, overageFee, total]
  );

  return {
    ...inv,
    tenantName: row.name,
    used,
    includedCalls: row.included_calls,
    apiCost: parseFloat(row.api_cost),
    margin: total - parseFloat(row.api_cost),   // 이 고객에서 남은 금액
  };
}

function previousPeriod() {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

/**
 * 정기결제 실행 (PG 연동)
 * billing_key 는 고객이 카드 등록 시 PG사에서 발급받아 subscriptions 에 저장해둔 값입니다.
 */
async function chargeInvoice(invoiceId) {
  const inv = await db.one(
    `SELECT i.*, s.billing_key, t.name AS tenant_name
       FROM invoices i
       JOIN tenants t ON t.id = i.tenant_id
       LEFT JOIN subscriptions s ON s.tenant_id = i.tenant_id AND s.status='active'
      WHERE i.id = $1`,
    [invoiceId]
  );
  if (!inv) throw new Error('청구서를 찾을 수 없습니다');
  if (inv.status === 'paid') return { alreadyPaid: true };
  if (inv.total_fee === 0) {
    await db.query(`UPDATE invoices SET status='paid', paid_at=now() WHERE id=$1`, [invoiceId]);
    return { free: true };
  }

  if (!cfg.pg.secretKey || !inv.billing_key) {
    // PG 미연동 상태 — 청구서만 남기고 수동 처리
    return { pending: true, reason: 'PG 미연동 또는 카드 미등록. 수동 청구가 필요합니다.' };
  }

  // 토스페이먼츠 빌링 예시. 다른 PG를 쓰면 이 부분만 교체하세요.
  const res = await fetch(`${cfg.pg.apiUrl}/billing/${inv.billing_key}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Basic ' + Buffer.from(cfg.pg.secretKey + ':').toString('base64'),
    },
    body: JSON.stringify({
      customerKey: 'tenant_' + inv.tenant_id,
      amount: inv.total_fee,
      orderId: `INV-${inv.tenant_id}-${inv.period}`,
      orderName: `100°10 AI감시 ${inv.period} 이용료`,
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    await db.query(`UPDATE invoices SET status='failed' WHERE id=$1`, [invoiceId]);
    throw new Error('결제 실패: ' + (body.message || res.status));
  }

  await db.query(
    `UPDATE invoices SET status='paid', paid_at=now(), pg_tid=$2 WHERE id=$1`,
    [invoiceId, body.paymentKey || null]
  );
  return { paid: true, tid: body.paymentKey };
}

/** 요금제 변경 */
async function changePlan(tenantId, planCode) {
  const plan = await db.one('SELECT * FROM plans WHERE code = $1', [planCode]);
  if (!plan) throw new Error('없는 요금제입니다');

  await db.tx(async (c) => {
    await c.query('UPDATE tenants SET plan_code = $2 WHERE id = $1', [tenantId, planCode]);
    await c.query(`UPDATE subscriptions SET status='cancelled', ends_at=now()
                    WHERE tenant_id=$1 AND status='active'`, [tenantId]);
    await c.query(`INSERT INTO subscriptions (tenant_id, plan_code, status)
                   VALUES ($1,$2,'active')`, [tenantId, planCode]);
  });
  return plan;
}

/** 미납 고객 정지 (연체 관리) */
async function suspendUnpaid(daysOverdue) {
  const d = daysOverdue || 7;
  const rows = await db.many(
    `UPDATE tenants SET status='suspended'
      WHERE id IN (
        SELECT tenant_id FROM invoices
         WHERE status IN ('pending','failed')
           AND created_at < now() - ($1 || ' days')::interval
      ) AND status='active'
      RETURNING id, name`,
    [String(d)]
  );
  return rows;
}

module.exports = { generateInvoice, chargeInvoice, changePlan, suspendUnpaid, previousPeriod };
