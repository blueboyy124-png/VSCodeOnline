const CACHE_NAME = 'mini-vscode-v8';

// These are YOUR app files — always fetch fresh from network, cache as fallback
const APP_FILES = [
  './index.html',
  './style.css', 
  './script.js',
  './manifest.json'
];

// ── Install: pre-cache app files ──────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting()) // activate immediately
  );
});

// ── Activate: wipe every old cache ───────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) =>
        Promise.all(
          names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
        )
      )
      .then(() => self.clients.claim()) // take over all open tabs immediately
  );
});

// ── Skip-waiting message from update banner ───────────────────────
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

// ── Fetch: network-first for app files, cache-first for CDN ──────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isAppFile = APP_FILES.some((f) =>
    url.pathname.endsWith(f.replace('./', '/')) ||
    url.pathname === '/' ||
    url.pathname === '/index.html'
  );

  if (isAppFile) {
    // Network-first: always try to get the latest version.
    // Falls back to cache only if the network is unreachable (offline).
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          // Update the cache with the fresh response
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return networkResponse;
        })
        .catch(() => caches.match(event.request)) // offline fallback
    );
  } else {
    // Cache-first for CDN assets (Monaco, xterm, etc.) — these never change
    event.respondWith(
      caches.match(event.request)
        .then((cached) => cached || fetch(event.request))
    );
  }
});