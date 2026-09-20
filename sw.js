'use strict';

// Bump this value whenever a published application file changes.
const VERSION = 'v2.2.0-beta.1';
// A GitHub Pages origin may host several apps. Only manage this app's caches.
const CACHE_PREFIX = `na-kontroli::${encodeURIComponent(self.registration.scope)}::`;
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;
const APP_FILES = [
  './index.html',
  './styles.css',
  './guide.css',
  './js/guide.js',
  './js/app.js',
  './js/pin-pad.js',
  './js/teams.js',
  './js/login.js',
  './js/firebase-config.js',
  './js/firebase-transport.js',
  './js/vendor/firebase.js',
  './firebase/firestore.rules',
  './firebase/firestore.indexes.json',
  './docs/FIREBASE-SETUP.md',
  './js/store.js',
  './js/dates.js',
  './js/steps.js',
  './js/recurrence.js',
  './js/alerts.js',
  './bootstrap.min.css',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
];
const APP_URLS = new Set(APP_FILES.map((path) => new URL(path, self.registration.scope).href));
const INDEX_URL = new URL('./index.html', self.registration.scope).href;

self.addEventListener('install', (event) => {
  // Installation succeeds only after the complete app is available offline.
  // A new release waits for open app windows to close before it takes over.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll([...APP_URLS].map((url) => new Request(url, { cache: 'reload' })));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    // Attach the first open page without reloading it or discarding form input.
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;

  const canonicalURL = new URL(url.pathname, url.origin).href;
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      return (await cache.match(INDEX_URL)) || fetch(request);
    })());
    return;
  }

  // Cache only the shipped app shell. User records never enter Cache Storage.
  if (APP_URLS.has(canonicalURL)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      return (await cache.match(canonicalURL)) || fetch(request);
    })());
  }
});

// Local notifications are shown by the unlocked foreground page only.
// This handler does not schedule work, fetch task data, or receive push messages.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const scope = new URL(self.registration.scope);
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const target = windows.find((client) => {
      const url = new URL(client.url);
      return url.origin === scope.origin && url.pathname.startsWith(scope.pathname);
    });
    if (target) await target.focus();
    else await self.clients.openWindow(self.registration.scope);
  })());
});
