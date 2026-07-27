/**
 * 매월 1일에 실행 — 전월 청구서를 만들고 정기결제를 시도한다.
 * cron 예시:  0 3 1 * *  cd /srv/vlm-server && node scripts/monthly-invoice.js
 */
const db = require('../src/db');
const billing = require('../src/services/billing');

(async () => {
  const period = billing.previousPeriod();
  const tenants = await db.many("SELECT id, name FROM tenants WHERE status='active'");
  console.log(`[청구] ${period} 대상 ${tenants.length}곳`);

  let paid = 0, pending = 0, failed = 0;
  for (const t of tenants) {
    try {
      const inv = await billing.generateInvoice(t.id, period);
      console.log(`  ${t.name}: ${inv.total_fee.toLocaleString()}원 ` +
                  `(사용 ${inv.used}/${inv.includedCalls}, 원가 ${Math.round(inv.apiCost)}원, 마진 ${Math.round(inv.margin)}원)`);
      const r = await billing.chargeInvoice(inv.id);
      if (r.paid || r.free || r.alreadyPaid) paid++;
      else pending++;
    } catch (e) {
      failed++;
      console.error(`  ${t.name}: 실패 — ${e.message}`);
    }
  }
  console.log(`[청구] 완료 — 결제 ${paid} / 대기 ${pending} / 실패 ${failed}`);

  const suspended = await billing.suspendUnpaid(7);
  if (suspended.length) console.log(`[정지] 미납 ${suspended.length}곳 정지 처리`);

  await db.pool.end();
})();
