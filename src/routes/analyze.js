const express = require('express');
const db = require('../db');
const claude = require('../services/claude');
const storage = require('../services/storage');
const notify = require('../services/notify');
const { deviceAuth } = require('../middleware/auth');
const { checkQuota, recordUsage } = require('../middleware/usage');

const router = express.Router();

/**
 * POST /api/analyze
 * 현장 앱이 움직임을 감지했을 때 호출하는 핵심 엔드포인트.
 *
 * 헤더: X-Device-Key
 * 본문: { image: base64, mimeType, reason: 'motion'|'flame'|'small'|'door',
 *         direction: 'in'|'out' (출입 모드), fast: true }
 */
router.post('/analyze', deviceAuth, checkQuota, async (req, res) => {
  const t0 = Date.now();
  const { image, mimeType, reason = 'motion', direction, fast = true } = req.body || {};

  if (!image) return res.status(400).json({ error: '이미지가 없습니다' });
  // base64 크기 제한 (약 3MB) — 과도한 업로드로 인한 비용·부하 방지
  if (image.length > 4_000_000) return res.status(413).json({ error: '이미지가 너무 큽니다' });

  try {
    // 1) 현장 설정(지식·규칙·감지대상) 불러오기
    const site = req.device.siteId
      ? await db.one('SELECT knowledge, rules, targets FROM sites WHERE id = $1', [req.device.siteId])
      : { knowledge: '', rules: [], targets: [] };

    // 2) 최근 기록 5건 (RAG 맥락)
    const recent = await db.many(
      `SELECT situation, level, created_at FROM events
        WHERE device_id = $1 ORDER BY created_at DESC LIMIT 5`,
      [req.device.id]
    );

    // 3) 모드에 맞는 프롬프트 구성
    const isDoor = reason === 'door';
    const system = isDoor
      ? claude.buildDoorSystem(site, recent)
      : claude.buildWatchSystem(site, recent, reason);
    const userText = claude.ASK[reason] || claude.ASK.motion;

    // 4) AI 분석
    const ai = await claude.callClaude({
      base64: image, mimeType, system, userText, fast,
      maxTokens: isDoor ? 120 : 280,
    });

    // 5) 응답 해석
    let level, situation, personCount = null, counted = false;
    if (isDoor) {
      const p = claude.parseDoor(ai.text);
      level = p.level; situation = p.situation;
      personCount = p.isPerson ? p.count : 0;
      counted = p.isPerson && p.count > 0;
    } else {
      const p = claude.parseWatch(ai.text);
      level = p.level; situation = p.situation;
    }

    // 6) 이미지 저장 (정상 상황은 저장하지 않아 용량·개인정보 최소화)
    let imagePath = null;
    if (level !== 'normal') {
      try { imagePath = storage.saveImage(req.tenant.id, image); }
      catch (e) { console.error('[저장] 이미지 실패:', e.message); }
    }

    // 7) 이벤트 기록 + 사용량 반영 (한 트랜잭션)
    const elapsed = Date.now() - t0;
    const event = await db.tx(async (client) => {
      const r = await client.query(
        `INSERT INTO events
           (tenant_id, device_id, level, reason, situation, raw_text, image_path,
            direction, person_count, input_tokens, output_tokens, cost_krw, elapsed_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id, created_at`,
        [req.tenant.id, req.device.id, level, reason, situation, ai.text, imagePath,
         counted ? (direction || null) : null, personCount,
         ai.inputTokens, ai.outputTokens, ai.costKrw, elapsed]
      );
      await recordUsage(req.tenant.id, ai.costKrw, client);
      return r.rows[0];
    });

    // 8) 경고면 즉시 알림 (실패해도 응답은 정상 반환)
    if (level === 'alert') {
      notify.sendAlert({
        tenant: req.tenant, device: req.device,
        eventId: event.id, situation, level,
      }).catch((e) => console.error('[알림] 실패:', e.message));
    }

    res.json({
      eventId: event.id,
      level, situation,
      text: ai.text,
      personCount, direction: counted ? direction : null,
      elapsedMs: elapsed,
      usage: {
        used: req.usage.used + 1,
        limit: req.usage.limit,
        overage: req.usage.overage,
      },
    });
  } catch (e) {
    console.error('[분석] 오류:', e.message);
    res.status(e.status === 401 ? 502 : 500).json({
      error: e.message || '분석 중 오류가 발생했습니다',
    });
  }
});

/** 현장 앱이 시작할 때 자기 설정을 받아가는 엔드포인트 */
router.get('/config', deviceAuth, async (req, res) => {
  const site = req.device.siteId
    ? await db.one('SELECT id, name, knowledge, rules, targets FROM sites WHERE id = $1', [req.device.siteId])
    : null;
  const u = await require('../middleware/usage').getUsage(req.tenant.id);
  res.json({
    device: req.device,
    tenant: { name: req.tenant.name, plan: req.plan.code },
    site: site || { knowledge: '', rules: [], targets: [] },
    usage: u,
  });
});

module.exports = router;
