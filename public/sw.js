/**
 * 서비스 워커 — 앱 화면을 기기에 저장해 빠르게 열리게 한다.
 *
 * 중요: 감지 분석(/api/*)은 절대 캐시하지 않는다. 항상 서버로 보내야 한다.
 * 화면 파일만 캐시하되, 새 버전이 있으면 자동으로 갱신한다.
 */
const CACHE = 'vlm-guard-v5';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // API 요청은 캐시하지 않는다 (분석·인증·기록은 항상 최신이어야 함)
  if (url.pathname.startsWith('/api/')) return;
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // 네트워크 우선 — 최신 화면을 받고, 실패하면 저장된 것을 보여준다
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
  );
});
