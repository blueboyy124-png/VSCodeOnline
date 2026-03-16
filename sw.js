const CACHE_NAME = 'mini-vscode-v15';

const APP_FILES = [
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  './icon192.png',
  './icon512.png'
];

// ── Install ───────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting())
  );
});

// ── Activate ──────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) =>
        Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
      )
      .then(() => self.clients.claim())
  );
});

// ── Skip-waiting ──────────────────────────────────────────────────
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

// ── Fetch ─────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // ── RULE 1: Never intercept cross-origin CDN requests ───────────
  // Some CDNs (unpkg.com, cdn.jsdelivr.net, etc.) return CORS headers
  // for direct Window fetches but NOT for fetch() calls originating
  // from inside a Service Worker. Intercepting them causes CORS errors.
  //
  // This is especially critical for Monaco worker pre-fetches: the main
  // page fetches worker scripts with cache:'no-store' so they bypass this
  // SW entirely and go directly to the CDN. DO NOT change this rule.
  if (url.origin !== self.location.origin) {
    // Don't call respondWith — browser fetches the CDN directly.
    return;
  }

  // ── RULE 2: App files — network-first ────────────────────────────
  const isAppFile = APP_FILES.some((f) =>
    url.pathname.endsWith(f.replace('./', '/')) ||
    url.pathname === '/' ||
    url.pathname === '/index.html'
  );

  if (isAppFile) {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return resp;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // ── RULE 3: Same-origin assets — cache-first ─────────────────────
  event.respondWith(
    caches.match(event.request)
      .then((cached) => cached || fetch(event.request))
  );
});