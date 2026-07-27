const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { adminAuth, issueToken } = require('../middleware/auth');
const { getUsage, currentPeriod } = require('../middleware/usage');
const billing = require('../services/billing');
const storage = require('../services/storage');

const router = express.Router();

/* ── 회원가입 / 로그인 ─────────────────────────────── */
router.post('/signup', async (req, res) => {
  const { name, email, password, phone, ownerName } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: '상호명, 이메일, 비밀번호는 필수입니다' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: '비밀번호는 8자 이상이어야 합니다' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const t = await db.one(
      `INSERT INTO tenants (name, owner_name, email, password_hash, phone)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, name, email`,
      [name, ownerName || null, email.toLowerCase(), hash, phone || null]
    );
    await db.query(`INSERT INTO subscriptions (tenant_id, plan_code) VALUES ($1,'free')`, [t.id]);
    res.json({ token: issueToken(t), tenant: t });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: '이미 가입된 이메일입니다' });
    console.error('[가입] 오류:', e.message);
    res.status(500).json({ error: '가입 처리 중 오류가 발생했습니다' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  const t = await db.one('SELECT * FROM tenants WHERE email = $1', [String(email || '').toLowerCase()]);
  if (!t || !(await bcrypt.compare(String(password || ''), t.password_hash))) {
    return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다' });
  }
  res.json({ token: issueToken(t), tenant: { id: t.id, name: t.name, email: t.email } });
});

/* ── 대시보드 요약 ─────────────────────────────────── */
router.get('/summary', adminAuth, async (req, res) => {
  const id = req.auth.tenantId;
  const usage = await getUsage(id);
  const today = await db.one(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE level='alert')::int AS alerts,
            COUNT(*) FILTER (WHERE level='warn')::int  AS warns
       FROM events
      WHERE tenant_id=$1 AND created_at >= date_trunc('day', now())`, [id]);
  const devices = await db.many(
    `SELECT d.id, d.name, d.detect_mode, d.status, d.last_seen_at, s.name AS site_name
       FROM devices d LEFT JOIN sites s ON s.id=d.site_id
      WHERE d.tenant_id=$1 ORDER BY d.id`, [id]);
  const doorToday = await db.one(
    `SELECT COALESCE(SUM(person_count) FILTER (WHERE direction='in'),0)::int  AS entered,
            COALESCE(SUM(person_count) FILTER (WHERE direction='out'),0)::int AS exited
       FROM events
      WHERE tenant_id=$1 AND created_at >= date_trunc('day', now())`, [id]);

  res.json({ usage, today, devices, door: doorToday });
});

/* ── 이벤트 조회 ───────────────────────────────────── */
router.get('/events', adminAuth, async (req, res) => {
  const id = req.auth.tenantId;
  const { level, deviceId, limit = 50, offset = 0 } = req.query;
  const cond = ['tenant_id = $1'];
  const params = [id];
  if (level)    { params.push(level);    cond.push(`level = $${params.length}`); }
  if (deviceId) { params.push(deviceId); cond.push(`device_id = $${params.length}`); }
  params.push(Math.min(200, parseInt(limit, 10) || 50));
  params.push(parseInt(offset, 10) || 0);

  const rows = await db.many(
    `SELECT e.id, e.level, e.reason, e.situation, e.image_path, e.direction, e.person_count,
            e.cost_krw, e.elapsed_ms, e.created_at, d.name AS device_name
       FROM events e JOIN devices d ON d.id = e.device_id
      WHERE ${cond.join(' AND ')}
      ORDER BY e.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json({ events: rows });
});

/* 저장된 감지 이미지 (본인 것만) */
router.get('/image/:eventId', adminAuth, async (req, res) => {
  const row = await db.one(
    'SELECT image_path FROM events WHERE id=$1 AND tenant_id=$2',
    [req.params.eventId, req.auth.tenantId]);
  if (!row || !row.image_path) return res.status(404).end();
  res.sendFile(require('path').resolve(storage.imageFullPath(row.image_path)));
});

/* ── 현장 관리 ─────────────────────────────────────── */
router.get('/sites', adminAuth, async (req, res) => {
  res.json({ sites: await db.many('SELECT * FROM sites WHERE tenant_id=$1 ORDER BY id', [req.auth.tenantId]) });
});

router.post('/sites', adminAuth, async (req, res) => {
  const { name, address } = req.body || {};
  if (!name) return res.status(400).json({ error: '현장 이름이 필요합니다' });
  const s = await db.one(
    'INSERT INTO sites (tenant_id, name, address) VALUES ($1,$2,$3) RETURNING *',
    [req.auth.tenantId, name, address || null]);
  res.json({ site: s });
});

/* 현장 지식(RAG) 수정 — 앱의 '현장 지식' 화면이 여기에 저장된다 */
router.put('/sites/:id', adminAuth, async (req, res) => {
  const { knowledge, rules, targets, name } = req.body || {};
  const s = await db.one(
    `UPDATE sites SET
       knowledge = COALESCE($3, knowledge),
       rules     = COALESCE($4, rules),
       targets   = COALESCE($5, targets),
       name      = COALESCE($6, name)
     WHERE id=$1 AND tenant_id=$2 RETURNING *`,
    [req.params.id, req.auth.tenantId,
     knowledge ?? null,
     rules ? JSON.stringify(rules) : null,
     targets ? JSON.stringify(targets) : null,
     name ?? null]);
  if (!s) return res.status(404).json({ error: '현장을 찾을 수 없습니다' });
  res.json({ site: s });
});

/* ── 기기 관리 ─────────────────────────────────────── */
router.post('/devices', adminAuth, async (req, res) => {
  const { name, siteId, detectMode } = req.body || {};
  if (!name) return res.status(400).json({ error: '기기 이름이 필요합니다' });

  // 요금제별 기기 수 제한
  const cnt = await db.one(
    `SELECT COUNT(*)::int AS n, p.max_devices
       FROM devices d JOIN tenants t ON t.id=d.tenant_id JOIN plans p ON p.code=t.plan_code
      WHERE d.tenant_id=$1 GROUP BY p.max_devices`, [req.auth.tenantId]);
  if (cnt && cnt.n >= cnt.max_devices) {
    return res.status(403).json({ error: `현재 요금제는 기기 ${cnt.max_devices}대까지 등록할 수 있습니다` });
  }

  const key = 'dev_' + crypto.randomBytes(24).toString('hex');
  const d = await db.one(
    `INSERT INTO devices (tenant_id, site_id, name, device_key, detect_mode)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, name, device_key, detect_mode`,
    [req.auth.tenantId, siteId || null, name, key, detectMode || 'big']);
  res.json({ device: d, hint: '이 키를 현장 앱에 입력하세요. 다시 볼 수 없으니 저장해두세요.' });
});

router.delete('/devices/:id', adminAuth, async (req, res) => {
  await db.query('DELETE FROM devices WHERE id=$1 AND tenant_id=$2',
    [req.params.id, req.auth.tenantId]);
  res.json({ ok: true });
});

/* ── 요금제·청구 ───────────────────────────────────── */
router.get('/plans', async (req, res) => {
  res.json({ plans: await db.many('SELECT * FROM plans ORDER BY monthly_fee') });
});

router.post('/plan', adminAuth, async (req, res) => {
  try {
    const p = await billing.changePlan(req.auth.tenantId, req.body.planCode);
    res.json({ plan: p });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/invoices', adminAuth, async (req, res) => {
  res.json({
    invoices: await db.many(
      'SELECT * FROM invoices WHERE tenant_id=$1 ORDER BY period DESC LIMIT 24',
      [req.auth.tenantId]),
  });
});

module.exports = router;
