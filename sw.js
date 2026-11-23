// Service worker: cache app shell so the app opens and works offline.
const CACHE = 'nkscanpdf-v9';
const SHELL = [
  './camera.js',
  './worker.js',
  './icons/icon-64.png',
  './icons/apple-180.png',
  './icons/maskable-512.png',
  './fonts/BeVietnamPro-Medium.ttf',
  './fonts/BeVietnamPro-SemiBold.ttf',
  './fonts/BeVietnamPro-Bold.ttf',
  './fonts/BeVietnamPro-Black.ttf',
  './',
  './index.html',
  './styles.css',
  './app.js',
  './scan.js',
  './pdf.js',
  './db.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  // Network first (so updates arrive), fall back to cache when offline.
  // cache: 'no-cache' -> luôn hỏi máy chủ có bản mới chưa (bỏ qua bộ nhớ đệm HTTP của trình duyệt)
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('./index.html')))
  );
});
