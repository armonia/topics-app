// Topics PWA Service Worker
// Bump this version to force cache refresh.
// v9 (2026-05-11): removed self.skipWaiting() + self.clients.claim() so
// the SW no longer hijacks open tabs. Combined with the same-day fix to
// useServiceWorkerUpdate.ts (no polling, no auto-reload) and to the
// Electron asset-watcher (dev-only), this kills the "the app refreshes
// by itself" behaviour. The new SW now stays in `waiting` state until
// the user explicitly clicks the sidebar Reload button (which posts a
// SKIP_WAITING message — handler at the bottom of this file).
// v10 (2026-07-31): le navigazioni si cachano sotto UNA chiave canonica. Da
// quando la push punta a `/task/<uuid>` invece che a `/` (server/push-triggers.ts)
// ogni deep-link aperto da una notifica diventava una voce di cache distinta
// con dentro una copia intera della app shell, mai invalidata. Il bump serve
// anche a buttare via la `topics-v9`, che quelle copie le ha già accumulate.
const CACHE_VERSION = 10;
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

  // Ogni navigazione della SPA riceve la STESSA shell: `/`, `/task/<uuid>` e
  // `/topic/<id>` sono lo stesso index.html, il routing è tutto lato client.
  // Cacharle per URL faceva crescere la cache di una copia intera della shell
  // per ogni deep-link aperto da una notifica, e nessuna di quelle chiavi
  // veniva mai invalidata (CACHE_NAME è costante). Una chiave canonica sola:
  // si riscrive a ogni navigazione e vale da fallback offline per ogni rotta.
  const cacheKey = event.request.mode === 'navigate'
    ? new Request(new URL('/', self.location.origin).href)
    : event.request;

  event.respondWith(
    fetch(event.request).then((response) => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(cacheKey, clone);
        });
      }
      return response;
    }).catch(() => caches.match(cacheKey))
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

// Click su una notifica → porta l'utente DOVE dice la notifica.
//
// Con una finestra già aperta questo handler faceva `client.focus()` e buttava
// via `targetUrl`: la push ti svegliava e ti lasciava dove eri, a cercare da
// solo il task di cui ti aveva appena parlato. Il fix NON è `client.navigate()`
// — ricaricherebbe la SPA da zero (stato, pane, stream in corso) per un
// deep-link che l'app sa già aprire in-app. Passiamo la destinazione con un
// postMessage: `client/src/lib/openTaskLink.ts` la ascolta e apre il drawer.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
          return Promise.resolve(client.focus())
            .then((focused) => focused || client)
            .catch(() => client)
            .then((target) => {
              // best-effort: su un client non controllato il postMessage può
              // fallire, ma la finestra resta comunque a fuoco.
              try { target.postMessage({ type: 'topics:open-url', url: targetUrl }); } catch { /* ignore */ }
            });
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
