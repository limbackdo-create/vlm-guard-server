require('dotenv').config();

const cfg = {
  port: parseInt(process.env.PORT || '3000', 10),
  env: process.env.NODE_ENV || 'development',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-secret',
  databaseUrl: process.env.DATABASE_URL,

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    url: 'https://api.anthropic.com/v1/messages',
    version: '2023-06-01',
    modelFast: process.env.MODEL_FAST || 'claude-haiku-4-5-20251001',
    modelAccurate: process.env.MODEL_ACCURATE || 'claude-sonnet-5',
  },

  // 원가 계산용 단가 ($/100만 토큰)
  price: {
    usdKrw: parseFloat(process.env.USD_KRW || '1530'),
    inFast: parseFloat(process.env.PRICE_IN_FAST || '1.00'),
    outFast: parseFloat(process.env.PRICE_OUT_FAST || '5.00'),
    inAcc: parseFloat(process.env.PRICE_IN_ACC || '3.00'),
    outAcc: parseFloat(process.env.PRICE_OUT_ACC || '15.00'),
  },

  image: {
    dir: process.env.IMAGE_DIR || './data/images',
    retentionDays: parseInt(process.env.IMAGE_RETENTION_DAYS || '30', 10),
  },

  kakao: {
    url: process.env.KAKAO_API_URL,
    key: process.env.KAKAO_API_KEY,
    senderKey: process.env.KAKAO_SENDER_KEY,
    template: process.env.KAKAO_TEMPLATE_ALERT,
  },
  sms: {
    url: process.env.SMS_API_URL,
    key: process.env.SMS_API_KEY,
    sender: process.env.SMS_SENDER,
  },
  smtp: {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM,
  },
  pg: {
    provider: process.env.PG_PROVIDER || 'toss',
    secretKey: process.env.PG_SECRET_KEY,
    apiUrl: process.env.PG_API_URL,
  },
};

// 필수값 점검 — 없으면 시작 단계에서 바로 알려준다
function validate() {
  const missing = [];
  if (!cfg.databaseUrl) missing.push('DATABASE_URL');
  if (!cfg.anthropic.apiKey) missing.push('ANTHROPIC_API_KEY');
  if (cfg.env === 'production' && cfg.jwtSecret === 'dev-only-secret') {
    missing.push('JWT_SECRET (운영에서는 반드시 변경)');
  }
  if (missing.length) {
    console.error('[설정 오류] 다음 환경변수가 필요합니다:\n  - ' + missing.join('\n  - '));
    console.error('.env.example 을 복사해 .env 를 만들고 값을 채우세요.');
    process.exit(1);
  }
}

module.exports = { cfg, validate };
