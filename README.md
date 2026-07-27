# 100°10 AI 감시 서비스 — 백엔드 서버

계통도의 ②백엔드 · ③데이터저장 · ④알림 · ⑤관리자 를 구현한 서버입니다.

가장 중요한 역할 두 가지:
1. **API 키를 서버에만 보관** — 고객이 각자 키를 넣던 구조를 없앱니다
2. **요금제별 사용량 상한** — 원가 폭주를 막습니다

---

## 1. 설치

```bash
cd 서버
npm install
cp .env.example .env      # 값을 채우세요
```

**PostgreSQL 준비**

```bash
createdb vlm
psql "$DATABASE_URL" -f db/schema.sql
node scripts/seed.js       # 테스트 계정 생성 (선택)
```

**실행**

```bash
npm start
# 관리자 화면: http://localhost:3000/admin.html
```

## 2. 반드시 설정해야 하는 값

| 항목 | 설명 |
|---|---|
| `DATABASE_URL` | PostgreSQL 접속 주소 |
| `ANTHROPIC_API_KEY` | **여기에만** 넣습니다. 앱에는 절대 넣지 마세요 |
| `JWT_SECRET` | 길고 무작위한 문자열로 바꾸세요 |

알림(카카오·SMS)과 결제(PG)는 **대행사 계약 후** 값을 채우면 자동으로 켜집니다.
비어 있으면 해당 기능만 건너뛰고 나머지는 정상 동작합니다.

## 3. API

### 현장 앱용 (헤더: `X-Device-Key`)

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/analyze` | 감지 이미지 분석 요청 (핵심) |
| GET | `/api/config` | 현장 지식·규칙·사용량 받아가기 |

요청 예시:
```json
POST /api/analyze
{ "image": "<base64>", "mimeType": "image/jpeg",
  "reason": "motion", "direction": "in", "fast": true }
```

한도를 넘으면 `429` 와 함께 안내가 반환되고, AI를 호출하지 않습니다.

### 관리자용 (헤더: `Authorization: Bearer <token>`)

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/admin/signup` · `/login` | 가입 · 로그인 |
| GET | `/api/admin/summary` | 오늘 현황 · 사용량 · 기기 |
| GET | `/api/admin/events` | 감지 기록 조회 |
| POST | `/api/admin/devices` | 기기 등록 (기기 키 발급) |
| PUT | `/api/admin/sites/:id` | 현장 지식·규칙 수정 |
| POST | `/api/admin/plan` | 요금제 변경 |

## 4. 현장 앱 연결

앱(`감시카메라/index.html`)에서 Claude를 직접 부르던 부분을 이 서버로 바꾸면 됩니다.

```js
// 변경 전 — 앱에 API 키가 들어감 (위험)
fetch('https://api.anthropic.com/v1/messages', { headers:{'x-api-key': 내키} ... })

// 변경 후 — 서버가 대신 호출
fetch('https://내서버.com/api/analyze', {
  method:'POST',
  headers:{ 'content-type':'application/json', 'X-Device-Key': 발급받은키 },
  body: JSON.stringify({ image: base64, reason: 'motion', fast: true })
})
```

기기 키는 관리자 화면에서 **기기 등록** 시 발급됩니다.

## 5. 정기 작업 (cron 등록 권장)

```bash
# 매월 1일 새벽 3시 — 전월 청구서 생성 및 결제
0 3 1 * *  cd /srv/vlm-server && node scripts/monthly-invoice.js
```

이미지 보관기간 정리는 서버가 6시간마다 자동 실행합니다
(`IMAGE_RETENTION_DAYS`, 기본 30일).

## 6. 법적 준수 사항

CCTV를 설치·운영하면 **개인정보보호법**상 의무가 발생합니다.

- **안내판 설치가 의무**입니다. 설치 목적·장소, 촬영 범위·시간, 관리책임자 성명과 연락처를 기재해야 합니다
- **녹음 기능은 금지**입니다 (이 시스템은 영상만 처리합니다)
- 촬영 목적 외 임의 조작·다른 곳 촬영 금지
- 보관기간이 지난 영상은 지체 없이 파기 — `IMAGE_RETENTION_DAYS` 로 자동 처리

고객에게 판매할 때 안내판 양식을 함께 제공하면 분쟁을 줄일 수 있습니다.
정확한 적용 범위는 개인정보보호위원회 또는 변호사에게 확인하세요.

## 7. 구조

```
서버/
├─ db/schema.sql            요금제·고객·현장·기기·이벤트·사용량·청구
├─ src/
│  ├─ index.js              Express 앱
│  ├─ config.js             환경변수 검증
│  ├─ db.js                 PostgreSQL 연결
│  ├─ middleware/
│  │  ├─ auth.js            기기 키 · 관리자 JWT
│  │  └─ usage.js           ★ 사용량 상한 (원가 방어)
│  ├─ routes/
│  │  ├─ analyze.js         ★ 분석 엔드포인트
│  │  └─ admin.js           관리자 API
│  └─ services/
│     ├─ claude.js          프롬프트 구성(RAG) · AI 호출 · 응답 파싱
│     ├─ storage.js         이미지 저장 · 보관기간 정리
│     ├─ notify.js          카카오 · SMS · 이메일
│     └─ billing.js         청구서 · 정기결제 · 요금제 변경
├─ scripts/                 월 청구 · 테스트 데이터
└─ public/admin.html        관리자 대시보드
```

## 8. 운영 전 점검

- [ ] `JWT_SECRET` 을 무작위 값으로 변경
- [ ] HTTPS 적용 (Nginx + Let's Encrypt 등)
- [ ] DB 정기 백업 설정
- [ ] 카카오 알림톡 대행사 계약 및 템플릿 승인
- [ ] PG사 계약 및 정기결제 연동
- [ ] 개인정보 처리방침 작성 및 안내판 양식 준비
