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
// v11 (2026-07-31): retry-con-backoff sulle NAVIGAZIONI prima del fallback su
// cache (vedi handler `fetch` più sotto). Il bump serve anche a buttare via
// qualunque shell di build precedente rimasta in `topics-v10`, che è proprio
// quella che il vecchio fallback-immediato serviva durante un riavvio del server.
const CACHE_VERSION = 11;
const CACHE_NAME = `topics-v${CACHE_VERSION}`;

// Un fallimento di rete su una navigazione ha DUE cause che il vecchio
// `.catch(() => caches.match(...))` non sapeva distinguere:
//   · offline vero (treno, niente wifi) → la shell cachata è lo scopo stesso
//     della PWA, servila subito;
//   · il server locale che rimbalza per qualche centinaio di ms (`bun --watch`
//     che ricompila) → qui la shell in cache è di una build PRECEDENTE, e
//     servirla innesca il client stantìo e il loop del banner "nuova versione"
//     proprio mentre il server fresco sta già tornando su.
// Da un singolo fallimento le due cause sono indistinguibili, ma nel TEMPO no:
// un riavvio-watch risponde entro ~1s, un offline vero no. Quindi per le
// navigazioni ritentiamo la rete un paio di volte con un backoff corto prima di
// arrenderci alla cache. Gli asset mantengono il fallback a colpo singolo.
const NAV_RETRIES = 3;
const NAV_BACKOFF_MS = 300;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Network-first per le navigazioni, ma con retry: solo dopo NAV_RETRIES fetch
// fallite (rete irraggiungibile) cadiamo sulla shell cachata. Una risposta HTTP
// che arriva — anche non-ok — chiude il giro senza ritentare: il server c'è, la
// sua risposta è autorevole, non è il caso "server assente" che vogliamo coprire.
async function navigationFetch(request, cacheKey) {
  for (let attempt = 0; attempt < NAV_RETRIES; attempt++) {
    try {
      const response = await fetch(request);
      if (response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey, clone));
      }
      return response;
    } catch (err) {
      // Rete irraggiungibile. Se restano tentativi, aspetta e riprova: un
      // rimbalzo di `bun --watch` risponde prima di esaurirli.
      if (attempt < NAV_RETRIES - 1) {
        await delay(NAV_BACKOFF_MS);
        continue;
      }
      // Tentativi finiti → davvero offline. Shell cachata se c'è, altrimenti
      // rilancia l'errore di rete (nessun fallback possibile).
      const cached = await caches.match(cacheKey);
      if (cached) return cached;
      throw err;
    }
  }
}

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
  const isNavigation = event.request.mode === 'navigate';
  const cacheKey = isNavigation
    ? new Request(new URL('/', self.location.origin).href)
    : event.request;

  // Le navigazioni prendono il percorso con retry (distingue riavvio-server da
  // offline). Gli asset restano network-first a colpo singolo: un asset che
  // manca per un attimo verrà richiesto di nuovo dalla prossima navigazione, non
  // vale la pena tenerne in sospeso la fetch.
  if (isNavigation) {
    event.respondWith(navigationFetch(event.request, cacheKey));
    return;
  }

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
