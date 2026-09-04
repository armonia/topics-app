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
// v12 (2026-08-12): la notifica porta i TASTI e sceglie CHI la dice. Due cose
// che sono arrivate separate e vivono nello stesso handler `push`:
//   · i TASTI (`actions`) viaggiano nel payload e li ESEGUE il worker — vedi
//     l'handler `notificationclick` in fondo;
//   · `whenOpen` dice dove va la voce: con la preferenza `in-app` e una finestra
//     visibile il contenuto va alla PAGINA e la notifica di sistema non si
//     mostra affatto.
// Non sono due rami alternativi: i tasti valgono su entrambe le voci, perché
// scegliere dove leggere un avviso non è scegliere di non poterci rispondere.
// Il bump è quello che fa arrivare questo file ai client — un SW vecchio
// ignorerebbe `actions` E mostrerebbe la notifica comunque, cioè raddoppierebbe
// la voce proprio nel caso che questa versione esiste per risolvere.
const CACHE_VERSION = 12;
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

// Il canale verso la pagina quando è LEI a dover disegnare il banner.
// Gemello di `topics:open-url`; l'ascoltatore sta in client/src/lib/push/swBridge.ts.
const PUSH_BANNER_MESSAGE = 'topics:push-banner';

// Handle push notifications
//
// UNA VOCE SOLA, e la decide la preferenza del dispositivo che viaggia DENTRO il
// payload (`whenOpen`, scritto riga per riga da server/push-service.ts):
//   · `native` (default) → il banner lo mostra il sistema, sempre. La pagina, se
//     aperta, tace da sé: quando questo dispositivo è iscritto smette di
//     disegnare i banner degli eventi che il push copre (lib/notify/pushVoice.ts).
//   · `in-app`           → con una finestra VISIBILE il contenuto va alla pagina
//     e la notifica di sistema NON si mostra. Ad app chiusa (nessuna finestra
//     visibile) si ricade sul banner di sistema, che è l'unica voce rimasta.
//
// Sul non-mostrare: `userVisibleOnly` obbliga a una notifica visibile per ogni
// push, ma i browser fanno un'eccezione esplicita quando esiste già una finestra
// VISIBILE della stessa origine — è il caso, ed è l'unico ramo in cui si salta.
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data;
  try { data = event.data.json(); } catch { return; }

  event.waitUntil(deliverPush(data));
});

async function deliverPush(data) {
  const title = data.title || 'Topics';
  const body = data.body || 'New event';
  const url = data.url || '/';
  const tag = data.tag || 'topics-notification';
  // `requests` viaggia con la notifica: al click nessuno ricompone niente, si
  // esegue la chiamata che è arrivata (dopo il cancello sul path). Vale per
  // entrambe le voci — la esegue il worker sulla nativa, la pagina sul banner.
  const requests = data.requests || {};

  // I tasti dichiarati dal server, ripuliti UNA volta per tutte e due le voci.
  const declared = Array.isArray(data.actions) ? data.actions : [];
  const valid = declared.filter((a) => a && typeof a.id === 'string' && typeof a.title === 'string');

  // ── Voce 1: la PAGINA ────────────────────────────────────────────────────
  // Solo con la preferenza `in-app` E una finestra visibile. I tasti partono di
  // qui insieme al testo: `in-app` sceglie DOVE si legge l'avviso, non se ci si
  // può rispondere.
  //
  // Alla pagina vanno solo `id` e `title`: le `requests` restano qui. L'id
  // codifica il verbo per intero, e la pagina — che sta dentro il bundle e può
  // importare `shared/notify-actions` — la richiesta se la compone da sé, con lo
  // stesso esecutore del banner nativo. Le riceve già pronte solo chi non può
  // importare niente, cioè questo file.
  //
  // Nessun taglio a `maxActions`: quel tetto è del BROWSER e riguarda la
  // notifica di sistema — la pagina disegna i suoi bottoni e non ha quel limite
  // (il tutto-o-niente vero l'ha già applicato il server, in buildNotifyActions).
  if (data.whenOpen === 'in-app') {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visible = wins.filter((c) => c.visibilityState === 'visible');
    if (visible.length > 0) {
      for (const c of visible) {
        // best-effort: una finestra che sparisce fra il matchAll e il post non
        // deve impedire la consegna alle altre.
        try {
          c.postMessage({ type: PUSH_BANNER_MESSAGE, title, body, url, tag, actions: valid });
        } catch { /* ignore */ }
      }
      return;
    }
  }

  // ── Voce 2: il SISTEMA ───────────────────────────────────────────────────
  // Il default, e l'unica voce rimasta ad app chiusa (nessuna finestra visibile
  // → si cade qui anche con la preferenza `in-app`).
  //
  // Il browser mostra al massimo `Notification.maxActions` tasti (2 sul
  // desktop): il server ne manda già al massimo altrettanti e con la regola del
  // tutto-o-niente (shared/notify-actions), ma il taglio qui resta perché il
  // tetto è del BROWSER, non del contratto — su una piattaforma che ne accetta
  // uno solo, mostrarne due significa che il secondo sparisce in silenzio, e
  // sparirebbe proprio la risposta che non hai scelto di nascondere.
  const maxActions = typeof Notification !== 'undefined' && typeof Notification.maxActions === 'number'
    ? Notification.maxActions
    : 2;
  const actions = valid.length <= maxActions
    ? valid.map((a) => ({ action: a.id, title: a.title }))
    : []; // non ci stanno tutti → nessuno: mezza scelta non sembra mezza

  await self.registration.showNotification(title, {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag,
    data: { url, requests },
    renotify: true,
    vibrate: [100, 50, 100],
    ...(actions.length ? { actions } : {}),
  });
}

// Il cancello su ciò che un tasto può chiamare. Gemello di `isBoardActionPath`
// in shared/notify-actions.ts — qui riscritto perché sw.js non può importare
// nulla. È l'UNICA regola duplicata di tutta la catena, ed è duplicata apposta:
// una difesa che sta solo dall'altra parte del filo non difende chi esegue.
function isBoardActionPath(path) {
  return typeof path === 'string' && /^\/api\/boards\/[^/]+\/tasks\/[^/]+(\/[a-z-]+)?$/.test(path);
}

/**
 * Esegue il tasto premuto. Ritorna true se il server ha accettato.
 *
 * `credentials: 'same-origin'` è load-bearing: la sessione di Topics è un
 * cookie, e senza di lui la chiamata parte anonima e il gate d'autenticazione
 * la respinge — il tasto sembrerebbe rotto proprio sul dispositivo autorizzato.
 */
async function runNotificationAction(notification, actionId) {
  const req = (notification.data && notification.data.requests || {})[actionId];
  if (!req || !isBoardActionPath(req.path)) return false;
  if (req.method !== 'POST' && req.method !== 'PATCH') return false;
  try {
    const resp = await fetch(req.path, {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(req.body || {}),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// Click su una notifica → porta l'utente DOVE dice la notifica.
//
// Con una finestra già aperta questo handler faceva `client.focus()` e buttava
// via `targetUrl`: la push ti svegliava e ti lasciava dove eri, a cercare da
// solo il task di cui ti aveva appena parlato. Il fix NON è `client.navigate()`
// — ricaricherebbe la SPA da zero (stato, pane, stream in corso) per un
// deep-link che l'app sa già aprire in-app. Passiamo la destinazione con un
// postMessage: `client/src/lib/openTaskLink.ts` la ascolta e apre il drawer.
//
// Con un TASTO premuto (`event.action` valorizzato) il click non apre niente:
// esegue. È il senso stesso dei tasti — se ti aprisse comunque l'app avresti
// fatto due gesti per uno, e la notifica non ti avrebbe risparmiato nulla.
// Ma solo se il server ACCETTA: una chiamata fallita (offline, task che nel
// frattempo è uscito da review, checks rossi che il server rifiuta senza
// `force`) ricade sull'apertura del task, dove il perché si legge. Un tasto
// che non fa niente e non lo dice è peggio di un tasto che non c'è.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  const actionId = event.action;

  // A DETACHED window (`?topics=` / the historical `?topic=`) is a pop-out of
  // one or more chats, and it is the WRONG client to hand a deep-link to: over
  // there pane-store persistence is switched off on purpose, and the URL
  // reflection would wipe the very query that IS the window's identity, so on
  // the next reload the pop-out would reopen the whole workspace. The rule is
  // copied from `client/src/lib/windowRole.ts` instead of imported because a
  // service worker cannot import the client's modules.
  const isDetachedClient = (client) => {
    try {
      const params = new URL(client.url).searchParams;
      return ['topics', 'topic'].some((name) => (params.get(name) || '').trim().length > 0);
    } catch {
      return false;
    }
  };

  const openTarget = () =>
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      const sameOrigin = windowClients.filter((client) => {
        try { return new URL(client.url).origin === self.location.origin && 'focus' in client; }
        catch { return false; }
      });
      // The MAIN window first. Falling back to a detached one is still better
      // than silence: there the client-side guard forwards the link outside
      // instead of routing it (`openDeepLinkInApp`).
      const client = sameOrigin.find((c) => !isDetachedClient(c)) || sameOrigin[0];
      if (client) {
        return Promise.resolve(client.focus())
          .then((focused) => focused || client)
          .catch(() => client)
          .then((target) => {
            // best-effort: su un client non controllato il postMessage può
            // fallire, ma la finestra resta comunque a fuoco.
            try { target.postMessage({ type: 'topics:open-url', url: targetUrl }); } catch { /* ignore */ }
          });
      }
      return clients.openWindow(targetUrl);
    });

  if (actionId) {
    event.waitUntil(
      runNotificationAction(event.notification, actionId).then((ok) => (ok ? undefined : openTarget()))
    );
    return;
  }

  event.waitUntil(openTarget());
});

// Listen for skip-waiting message from client
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
