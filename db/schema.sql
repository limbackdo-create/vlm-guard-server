-- ============================================================
--  100°10 AI 감시 서비스 — PostgreSQL 스키마
--  실행: psql -U postgres -d vlm -f db/schema.sql
-- ============================================================

-- ── 요금제 ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS plans (
  code            TEXT PRIMARY KEY,          -- free / basic / standard / pro / enterprise
  name            TEXT NOT NULL,
  monthly_fee     INTEGER NOT NULL,          -- 원
  included_calls  INTEGER NOT NULL,          -- 월 포함 분석 횟수
  overage_fee     NUMERIC(10,2) NOT NULL DEFAULT 0,  -- 초과 1회당 원 (0이면 초과 시 차단)
  max_devices     INTEGER NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO plans (code,name,monthly_fee,included_calls,overage_fee,max_devices) VALUES
  ('free',      '무료 체험',      0,    300,  0,  1),
  ('basic',     '베이직',     29000,  3000,  0,  2),
  ('standard',  '스탠다드',   59000,  9000, 15,  5),
  ('pro',       '프로',       99000, 18000, 12, 15),
  ('enterprise','기업',      300000, 60000, 10, 100)
ON CONFLICT (code) DO NOTHING;

-- ── 고객(테넌트) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL,             -- 상호명
  owner_name      TEXT,
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,             -- 관리자 로그인용
  phone           TEXT,
  plan_code       TEXT NOT NULL REFERENCES plans(code) DEFAULT 'free',
  status          TEXT NOT NULL DEFAULT 'active',  -- active / suspended / cancelled
  -- 알림 수신 설정
  notify_kakao    BOOLEAN NOT NULL DEFAULT true,
  notify_sms      BOOLEAN NOT NULL DEFAULT false,
  notify_email    BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 현장(설치 장소) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS sites (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,             -- 예: 1층 출입구
  address         TEXT,
  -- 현장 지식 (RAG). 앱의 '현장 지식' 내용이 여기 저장된다.
  knowledge       TEXT DEFAULT '',
  rules           JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{from:22,to:6,text:"..."}]
  targets         JSONB NOT NULL DEFAULT '[]'::jsonb,   -- 감지 대상 목록
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sites_tenant ON sites(tenant_id);

-- ── 기기(카메라) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS devices (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id         BIGINT REFERENCES sites(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,             -- 예: 출입구 구형폰
  device_key      TEXT UNIQUE NOT NULL,      -- 앱이 헤더로 보내는 인증키
  detect_mode     TEXT NOT NULL DEFAULT 'big',  -- big / small / door
  last_seen_at    TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_devices_tenant ON devices(tenant_id);
CREATE INDEX IF NOT EXISTS idx_devices_key ON devices(device_key);

-- ── 감지 이벤트 ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id       BIGINT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  level           TEXT NOT NULL,             -- normal / warn / alert
  reason          TEXT,                      -- motion / flame / door
  situation       TEXT,                      -- AI가 요약한 상황 한 줄
  raw_text        TEXT,                      -- AI 원문 응답
  image_path      TEXT,                      -- 저장된 이미지 경로
  -- 출입 카운터용
  direction       TEXT,                      -- in / out / null
  person_count    INTEGER,
  -- 비용 추적
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cost_krw        NUMERIC(10,4),
  elapsed_ms      INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_tenant_time ON events(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_device_time ON events(device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_level ON events(tenant_id, level, created_at DESC);

-- ── 월별 사용량 (요금 계산 기준) ─────────────────────────
CREATE TABLE IF NOT EXISTS usage_monthly (
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period          TEXT NOT NULL,             -- 'YYYY-MM'
  call_count      INTEGER NOT NULL DEFAULT 0,
  cost_krw        NUMERIC(12,4) NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, period)
);

-- ── 알림 발송 이력 ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id        BIGINT REFERENCES events(id) ON DELETE SET NULL,
  channel         TEXT NOT NULL,             -- kakao / sms / email
  target          TEXT NOT NULL,             -- 수신처
  status          TEXT NOT NULL,             -- sent / failed
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notif_tenant ON notifications(tenant_id, created_at DESC);

-- ── 구독·결제 ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_code       TEXT NOT NULL REFERENCES plans(code),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at         TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'active',  -- active / cancelled / expired
  billing_key     TEXT                       -- PG사 정기결제 키 (토스·아임포트 등)
);
CREATE INDEX IF NOT EXISTS idx_subs_tenant ON subscriptions(tenant_id);

CREATE TABLE IF NOT EXISTS invoices (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period          TEXT NOT NULL,             -- 'YYYY-MM'
  base_fee        INTEGER NOT NULL,          -- 기본 구독료
  overage_calls   INTEGER NOT NULL DEFAULT 0,
  overage_fee     INTEGER NOT NULL DEFAULT 0,
  total_fee       INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending / paid / failed
  paid_at         TIMESTAMPTZ,
  pg_tid          TEXT,                      -- PG 거래번호
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period)
);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant ON invoices(tenant_id, period DESC);
