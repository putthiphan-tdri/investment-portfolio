// Bump this version whenever the app shell changes, including index.html/app.js/styles.css.
const VERSION = '20260923a';
const CACHE_PREFIX = `my-funds-shell-${encodeURIComponent(self.registration.scope)}-`;
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;
const SHELL_FILES = [
  './',
  './index.html',
  './styles.css?v=20260923a',
  './app.js?v=20260923a',
  './pwa.js?v=20260923a',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];
const shellURLs = new Set(SHELL_FILES.map((file) => new URL(file, self.registration.scope).href));

self.addEventListener('install', (event) => {
  // Keep the old, complete version until the new shell is fully downloaded.
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(
    [...shellURLs].map((url) => new Request(url, { cache: 'reload' }))
  )));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const rootURL = new URL('./', self.registration.scope);
  const indexURL = new URL('./index.html', self.registration.scope);
  const isAppNavigation = request.mode === 'navigate' && url.origin === rootURL.origin &&
    (url.pathname === rootURL.pathname || url.pathname === indexURL.pathname);
  // Never cache API responses, sync keys, imported files, or third-party resources.
  if (!isAppNavigation && !shellURLs.has(url.href)) return;
  const cacheKey = isAppNavigation ? indexURL.href : request.url;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    return (await cache.match(cacheKey)) || fetch(request);
  })());
});
