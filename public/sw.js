// デイプラン Service Worker v5 - アイコン更新
const CACHE = 'dayplanner-v5';
const ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(ASSETS.map(u => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── 通知クリック処理 ──
// 通知本体に { data: { url: '/?openTodo=tomorrow' } } を入れておくと、
// タップ時に該当URLを開く (PWA未起動時も含む)
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const targetUrl = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // 既存ウィンドウがあれば focus + navigate
    for (const c of clientsList) {
      if ('focus' in c) {
        await c.focus();
        if (c.navigate) { try { await c.navigate(targetUrl); } catch(_) {} }
        return;
      }
    }
    // 無ければ新規ウィンドウ
    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl);
    }
  })());
});

// ── Push 受信 (将来用) ──
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch(_) {}
  const title = data.title || '🌙 明日の予定を立てる時間です';
  const opts = {
    body: data.body || 'タップしてやることを整理しましょう',
    tag: data.tag || 'night-planner',
    data: { url: data.url || '/?openTodo=tomorrow' },
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

// HTML/JS/CSS は network-first（最新優先）・失敗時にキャッシュ
// アイコンなど静的ファイルは cache-first
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isAsset = /\.(html|js|css)$/.test(url.pathname) || url.pathname === '/';

  if (isAsset) {
    e.respondWith(
      fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match(req).then(c => c || caches.match('/index.html')))
    );
  } else {
    e.respondWith(
      caches.match(req).then(cached => cached || fetch(req))
    );
  }
});
