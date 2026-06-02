// Topics PWA Service Worker
// Bump this version to force cache refresh.
// v9 (2026-05-11): removed self.skipWaiting() + self.clients.claim() so
// the SW no longer hijacks open tabs. Combined with the same-day fix to
// useServiceWorkerUpdate.ts (no polling, no auto-reload) and to the
// Electron asset-watcher (dev-only), this kills the "the app refreshes
// by itself" behaviour. The new SW now stays in `waiting` state until
// the user explicitly clicks the sidebar Reload button (which posts a
// SKIP_WAITING message — handler at the bottom of this file).
const CACHE_VERSION = 9;
const CACHE_NAME = `topics-v${CACHE_VERSION}`;

// Install: register the SW. We DO NOT call self.skipWaiting() — the
// browser keeps the OLD SW in control until either the user closes every
// tab OR our app posts SKIP_WAITING via the sidebar Reload button. This
// preserves the user's session across silent backend rebuilds.
self.addEventListener('install', () => {
  // intentionally empty
});

// Activate: clean old caches. We DO NOT call self.clients.claim() — the
// new SW only takes control of pages on next navigation/reload. Pages
// that are already open keep using the old SW until they navigate or
// reload manually. The user stays in control.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
});

// Fetch: network-first, cache only as offline fallback
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;

  // API, WebSocket, chat — always network, never cache
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/ws') ||
      url.pathname.startsWith('/chat/')) {
    return;
  }

  event.respondWith(
    fetch(event.request).then((response) => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, clone);
        });
      }
      return response;
    }).catch(() => caches.match(event.request))
  );
});

// Handle push notifications
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data;
  try { data = event.data.json(); } catch { return; }

  const options = {
    body: data.body || 'New event',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || 'topics-notification',
    data: { url: data.url || '/' },
    renotify: true,
    vibrate: [100, 50, 100],
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'Topics', options)
  );
});

// Handle notification click
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});

// Listen for skip-waiting message from client
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
