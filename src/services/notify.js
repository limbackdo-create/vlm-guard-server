const nodemailer = require('nodemailer');
const { cfg } = require('../config');
const db = require('../db');

/**
 * 알림 발송 모듈
 *
 * 카카오 알림톡과 SMS는 대행사(비즈엠·솔라피·NHN 등)와 계약해야 쓸 수 있습니다.
 * 계약 후 .env 에 값을 넣으면 자동으로 켜지고, 비어 있으면 건너뜁니다.
 * 이메일은 SMTP만 있으면 바로 동작합니다.
 */

function alertMessage({ tenantName, deviceName, situation }) {
  const t = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  return `[100°10 AI감시] 경고\n` +
         `현장: ${tenantName} / ${deviceName}\n` +
         `상황: ${situation || '이상 상황 감지'}\n` +
         `시각: ${t}\n` +
         `확인이 필요합니다.`;
}

async function logNotification(tenantId, eventId, channel, target, status, error) {
  try {
    await db.query(
      `INSERT INTO notifications (tenant_id, event_id, channel, target, status, error)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [tenantId, eventId, channel, target, status, error || null]
    );
  } catch (e) { console.error('[알림] 이력 저장 실패:', e.message); }
}

/* ── 카카오 알림톡 ─────────────────────────────────── */
async function sendKakao(to, text) {
  if (!cfg.kakao.url || !cfg.kakao.key) {
    throw new Error('카카오 알림톡이 설정되지 않았습니다 (대행사 계약 필요)');
  }
  const res = await fetch(cfg.kakao.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.kakao.key}` },
    body: JSON.stringify({
      senderKey: cfg.kakao.senderKey,
      templateCode: cfg.kakao.template,
      to,
      text,
    }),
  });
  if (!res.ok) throw new Error('카카오 발송 실패: ' + res.status);
  return res.json().catch(() => ({}));
}

/* ── SMS ───────────────────────────────────────────── */
async function sendSms(to, text) {
  if (!cfg.sms.url || !cfg.sms.key) {
    throw new Error('SMS가 설정되지 않았습니다 (대행사 계약 필요)');
  }
  const res = await fetch(cfg.sms.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.sms.key}` },
    body: JSON.stringify({ from: cfg.sms.sender, to, text: text.slice(0, 90) }),
  });
  if (!res.ok) throw new Error('SMS 발송 실패: ' + res.status);
  return res.json().catch(() => ({}));
}

/* ── 이메일 ────────────────────────────────────────── */
let mailer = null;
function getMailer() {
  if (mailer) return mailer;
  if (!cfg.smtp.host) return null;
  mailer = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.port === 465,
    auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: cfg.smtp.pass } : undefined,
  });
  return mailer;
}

async function sendEmail(to, subject, text) {
  const m = getMailer();
  if (!m) throw new Error('SMTP가 설정되지 않았습니다');
  return m.sendMail({ from: cfg.smtp.from, to, subject, text });
}

/* ── 경고 알림 (설정된 모든 채널로) ────────────────── */
async function sendAlert({ tenant, device, eventId, situation }) {
  const text = alertMessage({
    tenantName: tenant.name, deviceName: device.name, situation,
  });
  const jobs = [];

  if (tenant.notify.kakao && tenant.phone) {
    jobs.push(
      sendKakao(tenant.phone, text)
        .then(() => logNotification(tenant.id, eventId, 'kakao', tenant.phone, 'sent'))
        .catch((e) => logNotification(tenant.id, eventId, 'kakao', tenant.phone, 'failed', e.message))
    );
  }
  if (tenant.notify.sms && tenant.phone) {
    jobs.push(
      sendSms(tenant.phone, text)
        .then(() => logNotification(tenant.id, eventId, 'sms', tenant.phone, 'sent'))
        .catch((e) => logNotification(tenant.id, eventId, 'sms', tenant.phone, 'failed', e.message))
    );
  }
  if (tenant.notify.email && tenant.email) {
    jobs.push(
      sendEmail(tenant.email, '[100°10 AI감시] 경고 발생', text)
        .then(() => logNotification(tenant.id, eventId, 'email', tenant.email, 'sent'))
        .catch((e) => logNotification(tenant.id, eventId, 'email', tenant.email, 'failed', e.message))
    );
  }

  await Promise.allSettled(jobs);
}

/* ── 사용량 경고 (80% 도달 시 안내) ────────────────── */
async function sendQuotaWarning(tenant, usage) {
  const text = `[100°10 AI감시] 사용량 안내\n` +
    `${tenant.name} 님, 이번 달 분석 횟수의 ${usage.percent}%를 사용하셨습니다.\n` +
    `(${usage.used} / ${usage.limit}회)\n` +
    `한도를 넘으면 분석이 중단될 수 있습니다.`;
  if (tenant.notify.email && tenant.email) {
    await sendEmail(tenant.email, '[100°10 AI감시] 사용량 안내', text).catch(() => {});
  }
}

module.exports = { sendAlert, sendQuotaWarning, sendEmail, sendKakao, sendSms };
