const express = require('express');
const cors = require('cors');
const path = require('path');
const { cfg, validate } = require('./config');
const storage = require('./services/storage');

validate();   // 필수 환경변수 확인 후 시작

const app = express();

app.use(cors());
// 감지 이미지는 base64로 오므로 본문 한도를 넉넉히 잡되, 라우터에서 크기를 다시 제한한다
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// 간단한 요청 로그
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api')) {
      console.log(`${res.statusCode} ${req.method} ${req.path} ${Date.now() - t}ms`);
    }
  });
  next();
});

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/api', require('./routes/analyze'));
app.use('/api/admin', require('./routes/admin'));

// 없는 경로
app.use('/api', (req, res) => res.status(404).json({ error: '없는 경로입니다' }));

// 오류 처리
app.use((err, req, res, next) => {
  console.error('[서버 오류]', err.message);
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: '전송 데이터가 너무 큽니다' });
  }
  res.status(500).json({ error: '서버 오류가 발생했습니다' });
});

const server = app.listen(cfg.port, async () => {
  console.log(`[시작] 100°10 AI 감시 서버 :${cfg.port} (${cfg.env})`);
  // 테이블이 없으면 자동 생성 (명령어 입력 없이 바로 사용 가능)
  try { await require('./migrate').autoMigrate(); }
  catch (e) { console.error('[경고] DB 준비 실패 — 설정을 확인하세요'); }
  console.log(`[관리자] http://localhost:${cfg.port}/admin.html`);
});

// 오래된 이미지 정리 — 개인정보보호법상 보관기간 준수
setInterval(() => {
  try {
    const r = storage.cleanupOldImages();
    if (r.deleted) console.log(`[정리] 보관기간 지난 이미지 ${r.deleted}건 삭제`);
  } catch (e) { console.error('[정리] 실패:', e.message); }
}, 6 * 60 * 60 * 1000);   // 6시간마다

// 안전한 종료
function shutdown() {
  console.log('[종료] 서버를 정리합니다...');
  server.close(() => {
    require('./db').pool.end().then(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = app;
