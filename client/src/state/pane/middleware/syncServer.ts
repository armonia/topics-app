/**
 * Debounced PUT /api/ui-state/pane-store-v2 with retry + inflight coalescing.
 *
 * Offline-first: actions always commit locally first; this middleware
 * propagates the syncable snapshot (device-local fields excluded) to the
 * server with exponential backoff on failure. A failed write never rolls
 * back client state — the user's edits are preserved.
 *
 * Inflight coalescing (PR-review #13): each in-flight PUT for a given key is
 * tracked with an `AbortController` + `snapshotSeq`. Before firing a new PUT
 * for the same key we abort the prior one — this prevents a stale retry from
 * committing after a fresher write succeeded. The server is LWW so it would
 * accept the stale write, but client-side the self-echo ledger (and any
 * observers) can see out-of-order seqs. `AbortError` is deliberately silent
 * (it's the coalesce path, not a failure).
 */
import { usePaneStore, type PaneStore } from '../store';
import { selectSyncableSnapshot } from '../selectors';
import { rememberLocalAck } from './selfEcho';
import { getTabId } from './syncCrossTab';
import { hasReceivedServerHydrate } from './serverHydrated';

const REMOTE_KEY = 'pane-store-v2';
const DEBOUNCE_MS = 500;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 200;

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

/**
 * IL CONTENUTO dell'ultimo snapshot che il server ha accettato, per chiave.
 *
 * PERCHÉ ESISTE. Il PUT parte quando `lastSeq` cambia, e `lastSeq` cambia a
 * OGNI dispatch — anche quando il reducer riscrive un valore identico a quello
 * che c'era già (`UPDATE_PANE` fa `{...pane, ...safe}` senza confrontare). Una
 * finestra ferma, che non riceve un gesto da nessuno, mandava così **un PUT da
 * 75 KB ogni 1,15 secondi, per sempre**: misurato il 2026-08-19 su questa
 * macchina, 16 PUT in 25 secondi con `lastSeq` che sale di 2 e NESSUN'ALTRA
 * differenza fra un corpo e il successivo.
 *
 * Non è solo banda sprecata. Il server è Bun con `bun:sqlite` SINCRONO: ogni
 * PUT è una scrittura che ferma l'event loop, e su HTTP/1.1 occupa una delle
 * SEI connessioni che il browser concede per host — quindi ritarda tutto ciò
 * che sta in coda dietro, comprese le letture che disegnano la board. Con 12
 * richieste pesanti in volo una richiesta da 212 byte ha aspettato 19,3
 * secondi (`scripts/hol-probe.mjs`): è quella coda a far sembrare lento un
 * refresh, non la lentezza di una singola rotta.
 *
 * LA DOMANDA È SUL CONTENUTO, NON SULLA SEQUENZA. Confrontare `lastSeq`
 * risponderebbe «è cambiato il contatore», che è vero per costruzione a ogni
 * dispatch. Ciò che il server deve sapere è se lo STATO è diverso, e per lo
 * stato la serializzazione È l'identità: è esattamente il byte che verrebbe
 * mandato. Il confronto costa una `JSON.stringify` di un corpo che, se il PUT
 * partisse, andrebbe comunque serializzato — quindi nel caso che conta (stato
 * cambiato) il costo è zero, e in quello frequente (stato fermo) risparmia una
 * scrittura su disco e un giro di rete.
 *
 * SI SCRIVE SOLO DOPO UN ACK. Ricordarlo al momento dell'invio direbbe «l'ho
 * mandato», non «il server ce l'ha»: un PUT fallito o abortito lascerebbe
 * l'ultima verità nota disallineata dal server e il prossimo tentativo verrebbe
 * saltato per un contenuto che non è mai atterrato. Vedi `rememberSynced`.
 */
const lastSyncedBody = new Map<string, string>();

/** Il corpo è già quello che il server ha? Allora non c'è niente da dire. */
function isAlreadySynced(key: string, body: string): boolean {
  return lastSyncedBody.get(key) === body;
}

/**
 * L'IDENTITÀ DI UNO STATO, che non comprende il suo contatore.
 *
 * `lastSeq` sta dentro lo snapshot, ma non È lo stato: è il numero d'ordine con
 * cui il server decide chi ha scritto per ultimo (LWW). Sale a ogni dispatch —
 * per costruzione, anche quando il reducer non tocca niente — quindi
 * confrontare il corpo INTERO risponderebbe sempre «diverso» e il gate qui
 * sopra non fermerebbe un solo PUT.
 *
 * Toglierlo dal confronto è sicuro proprio per il ruolo che ha: se lo stato non
 * è cambiato, il server ha già la sola cosa che gli serve, e un numero d'ordine
 * più alto su un contenuto identico non gli direbbe niente di nuovo. Quando
 * qualcosa cambierà davvero, quel PUT partirà con il `lastSeq` corrente — che a
 * quel punto è più alto di prima — e vincerà il confronto come sempre.
 */
function syncIdentity(snapshot: unknown): string {
  const { lastSeq: _ordine, ...stato } = (snapshot ?? {}) as Record<string, unknown>;
  void _ordine;
  return JSON.stringify(stato);
}

/** Il server ha ACCETTATO questo corpo: da qui in poi è la verità nota. */
function rememberSynced(key: string, body: string): void {
  lastSyncedBody.set(key, body);
}

/**
 * Dimentica ciò che credevamo sincronizzato.
 *
 * Serve a ogni evento che può aver spostato la riga sul server SENZA passare
 * da noi — un'altra scheda, un altro dispositivo, una riconnessione del socket.
 * Dopo uno di quelli il nostro «uguale a prima» non descrive più il server, e
 * saltare il PUT lascerebbe le due parti ferme su stati diversi. Sbagliare in
 * questa direzione costa un PUT in più; sbagliare nell'altra costa uno stato
 * che non si sincronizza mai.
 */
function forgetSynced(): void {
  lastSyncedBody.clear();
}

interface InflightEntry {
  controller: AbortController;
  snapshotSeq: number;
}

// Keyed on the remote key (e.g. "pane-store-v2"). One entry per key — a new
// PUT for the same key aborts the prior inflight. See module header.
const inflight = new Map<string, InflightEntry>();

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * Advance the compare-and-swap base after the SERVER accepts one of our writes.
 *
 * Necessary because our own write never comes back through HYDRATE — the
 * self-echo filter (selfEcho.ts) drops the broadcast it triggers, and that
 * HYDRATE is the only other thing that moves `lastServerSeq`. Without this the
 * base would freeze at the last REMOTE frame we saw, and every teardown flush
 * after any local edit would 409 forever: the gate would be permanently on.
 *
 * The ack tells us exactly what we need — the row is now at `server_seq` AND
 * its content is our snapshot — so this tab is, by definition, current at it.
 */
function advanceServerBase(server_seq: number): void {
  usePaneStore.setState((draft) => {
    if (server_seq > draft.lastServerSeq) draft.lastServerSeq = server_seq;
  });
}

/**
 * Fire a PUT for `key` with inflight-abort semantics. If an older PUT for the
 * same key is in flight it is aborted first. The retry chain uses the same
 * AbortController so a newer PUT arriving mid-backoff cancels the chain.
 */
async function pushSnapshot(
  key: string,
  snapshot: unknown,
  snapshotSeq: number,
  baseSeq?: number,
): Promise<void> {
  const prior = inflight.get(key);
  if (prior) prior.controller.abort();

  const controller = new AbortController();
  const entry: InflightEntry = { controller, snapshotSeq };
  inflight.set(key, entry);

  try {
    await putWithRetry(key, snapshot, controller.signal, 0, baseSeq);
  } finally {
    // Only clear the slot if we're still the registered owner — a newer PUT
    // may have replaced us (prior.controller.abort() on its entry) and we
    // must not wipe its bookkeeping.
    if (inflight.get(key) === entry) inflight.delete(key);
  }
}

async function putWithRetry(
  key: string,
  snapshot: unknown,
  signal: AbortSignal,
  attempt: number,
  baseSeq?: number,
): Promise<void> {
  try {
    // Finding #10: tag the PUT with this tab's id so the server can echo it
    // back on the broadcast as `sourceClientId`. syncWS.ts uses that as a
    // defence-in-depth filter on top of `isSelfEcho(server_seq)` — catches
    // the case where the ack is lost (crash mid-PUT, reconnect) while the
    // broadcast still lands.
    const url =
      baseSeq === undefined ? `/api/ui-state/${key}` : `/api/ui-state/${key}?base=${baseSeq}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': getTabId(),
      },
      body: JSON.stringify(snapshot),
      signal,
    });
    if (res.ok) {
      // Il server ha preso QUESTO corpo: da qui in poi è ciò che sappiamo di
      // lui, e un prossimo invio identico non ha niente da dirgli.
      rememberSynced(key, syncIdentity(snapshot));
      try {
        const body = (await res.json()) as { server_seq?: number } | null;
        if (body && typeof body.server_seq === 'number') {
          rememberLocalAck(body.server_seq);
          advanceServerBase(body.server_seq);
        }
      } catch {
        /* response may be empty / non-JSON; non-fatal */
      }
      return;
    }
    // 409 = compare-and-swap conflict: someone moved the row past our `base`.
    // Terminal, never retried — the body we hold is exactly the stale snapshot
    // the server just refused, so re-sending it can only fail again (or, if the
    // row settles, succeed at overwriting fresher state, which is the bug).
    if (res.status === 409) return;
    if (attempt < MAX_RETRIES) {
      await backoffDelay(attempt, signal);
      if (signal.aborted) return;
      return putWithRetry(key, snapshot, signal, attempt + 1, baseSeq);
    }
  } catch (err) {
    // AbortError is the coalesce path — a newer PUT took over. Silent.
    if (isAbortError(err) || signal.aborted) return;
    if (attempt < MAX_RETRIES) {
      try {
        await backoffDelay(attempt, signal);
      } catch {
        return;
      }
      if (signal.aborted) return;
      return putWithRetry(key, snapshot, signal, attempt + 1, baseSeq);
    }
  }
}

/**
 * Sleep for `BASE_BACKOFF_MS * 2^attempt` ms with ±20% jitter, resolving
 * early (no throw) if `signal` is aborted — so a newer PUT can short-circuit
 * the retry chain of a stale one.
 */
function backoffDelay(attempt: number, signal: AbortSignal): Promise<void> {
  const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
  const jittered = backoff * (0.8 + Math.random() * 0.4);
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, jittered);
    const onAbort = () => {
      clearTimeout(t);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * URL for a TEARDOWN flush, carrying the compare-and-swap base seq.
 *
 * Teardown flushes are the one write we cannot trust: the tab may have slept
 * through another device's changes, and the server stamps every PUT with a
 * fresh, higher `server_seq` — which is what the HYDRATE gate compares. So a
 * stale flush doesn't just lose a little state, it OUTRANKS everyone and drags
 * every other device back in time. `?base=` tells the server "only take this
 * if the row is still where I last saw it" (routes/ui-state.ts): if another
 * writer moved on, our flush is dropped with a 409 and nothing is broadcast.
 *
 * Only teardown paths declare a base. The debounced PUT keeps writing
 * unconditionally: it runs milliseconds after a local action on a live tab,
 * and a 409 there would need a hydrate-and-re-push loop to avoid losing the
 * user's edit. The dying-tab case has no such need — losing IS the fix.
 */
function teardownFlushUrl(baseServerSeq: number): string {
  return `/api/ui-state/${REMOTE_KEY}?base=${baseServerSeq}`;
}

/**
 * Fire a PUT immediately via `fetch({ keepalive: true })`. Unlike sendBeacon,
 * keepalive fetch survives the page teardown race AND exposes the Response, so
 * we can parse `server_seq` and call `rememberLocalAck` — critical on the
 * `visibilitychange === 'hidden'` path where the tab may resume and receive
 * the WS broadcast of our own write (self-echo contract).
 *
 * Note: keepalive teardown-flush bypasses the inflight Map — the tab is
 * going away (or about to), so stale-vs-fresh coalescing doesn't matter;
 * we want the write to land, full stop.
 */
function flushNowKeepalive(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  // Same boot-time hydrate guard as the debounced PUT (initServerSync) and
  // flushPaneStoreNow: until the server has hydrated us, the store is the
  // empty default (or a warm local-snapshot) and is NOT authoritative. A
  // teardown that fires pre-hydrate — a fast reload/nav storm, or a page that
  // closes before the WS `ui-state:init` lands — would otherwise PUT that
  // empty snapshot and clobber the server's good copy (the exact reload-storm
  // pathology the debounce guard fixed, minus this path). Skip the flush.
  if (!hasReceivedServerHydrate()) return;
  const state = usePaneStore.getState();
  const snap = selectSyncableSnapshot(state);
  void (async () => {
    try {
      // Finding #10: X-Client-Id on the keepalive teardown path too.
      const res = await fetch(`${teardownFlushUrl(state.lastServerSeq)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': getTabId(),
        },
        body: JSON.stringify(snap),
        keepalive: true,
      });
      if (res.ok) {
        try {
          const body = (await res.json()) as { server_seq?: number } | null;
          if (body && typeof body.server_seq === 'number') {
            rememberLocalAck(body.server_seq);
            advanceServerBase(body.server_seq);
          }
        } catch { /* non-JSON response; non-fatal */ }
      }
    } catch {
      // keepalive fetch failed (e.g. page tearing down too fast) — best effort.
    }
  })();
}

/**
 * Fire-and-forget flush via `navigator.sendBeacon`. Used on `pagehide` where
 * the page is terminating — the Response will never be read, so we cannot
 * call `rememberLocalAck`. This is acceptable: after pagehide the tab won't
 * resume to process WS frames, so the self-echo contract doesn't matter.
 */
function flushNowBeacon(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  // Same boot-time hydrate guard as flushNowKeepalive — a pre-hydrate pagehide
  // must not beacon the empty default store over the server's authoritative copy.
  if (!hasReceivedServerHydrate()) return;
  const state = usePaneStore.getState();
  const snap = selectSyncableSnapshot(state);
  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    try {
      const blob = new Blob([JSON.stringify(snap)], { type: 'application/json' });
      // Finding #10: sendBeacon can't set custom headers — use the `?cid=`
      // query param instead. Server reads header first, falls back to query.
      // `base` rides the same query string (see teardownFlushUrl): we can't
      // read the 409 here, and we don't need to — the point is that a stale
      // beacon from a dying tab is REJECTED rather than winning on seq.
      const beaconUrl = `${teardownFlushUrl(state.lastServerSeq)}&cid=${encodeURIComponent(getTabId())}`;
      if (navigator.sendBeacon(beaconUrl, blob)) return;
    } catch { /* fall through to fetch */ }
  }
  // Beacon unavailable or failed — last resort; response won't be read but
  // the write may still land if the browser hasn't torn down the process yet.
  // Still a teardown flush, so it carries the same CAS base.
  void pushSnapshot(REMOTE_KEY, snap, state.lastSeq, state.lastServerSeq);
}

export function initServerSync(): void {
  if (started) return;
  started = true;

  usePaneStore.subscribe(
    (s: PaneStore) => s.lastSeq,
    () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        // ── Hydrate guard (post-mortem fix) ──────────────────────────────
        // Don't push our snapshot until the server has hydrated us. Without
        // this guard, an `OPEN_PANE` / `FOCUS_PANE` dispatched in the first
        // ~500 ms after mount (e.g. from a saved hash route or restored
        // tab) bumps `lastSeq`, and after DEBOUNCE_MS we'd PUT a default
        // `openChatTopicIds: []` snapshot that the server's LWW accepts —
        // wiping the user's open tabs. This bug was discovered after the
        // Phase A→H merge: a 30-file fswatch storm reloaded Electron
        // ~30 times, and each reload's pre-hydrate PUT raced to clobber
        // pane-store-v2 server-side.
        //
        // Once the first `ui-state:init` lands `markServerHydrated()` flips
        // and stays flipped for the rest of the session, so this is a
        // boot-time check only — there is no perpetual gating on PUTs.
        if (!hasReceivedServerHydrate()) {
          // Re-arm: try again next time lastSeq changes. By then the WS
          // init should have arrived (or the GET fallback inside
          // bootstrap will have fired markServerHydrated).
          return;
        }
        // selectSyncableSnapshot excludes focusedPaneId and pane.scrollOffset —
        // device-local fields never cross the network per CONTEXT.md.
        const state = usePaneStore.getState();
        const snap = selectSyncableSnapshot(state);
        // LO STATO È FERMO: non c'è niente da mandare. `lastSeq` è salito
        // (ogni dispatch lo alza, anche uno che riscrive valori identici) ma il
        // contenuto no, e il contenuto è ciò di cui il server ha bisogno. Senza
        // questa domanda una finestra ferma PUT-tava 75 KB ogni 1,15 s per
        // sempre — vedi `lastSyncedBody`.
        if (isAlreadySynced(REMOTE_KEY, syncIdentity(snap))) return;
        void pushSnapshot(REMOTE_KEY, snap, state.lastSeq);
      }, DEBOUNCE_MS);
    },
  );

  // Review-round-13: abort any inflight PUT on WS close. Rationale: when the
  // socket drops, the connection that would deliver our PUT's ack is gone,
  // and a retry-on-reconnect PUT would race against the fresh `ui-state:init`
  // broadcast the server sends on WS reopen (our self-echo filter resets on
  // 'open', so a post-reset ack could be misread as a remote frame). Simpler:
  // abandon the in-flight write; the next `lastSeq` tick will re-push with
  // the current state once the WS is back.
  if (typeof window !== 'undefined') {
    // Lazily import to avoid a circular dep at module init. La destrutturazione
    // sta nell'`await` e non nel `.then` perché è l'unica forma in cui knip vede
    // quali export usi: un `import()` opaco rende immortale ogni export del
    // modulo (`bun run check:deadcode-blindspots`).
    void (async () => {
      const { subscribeLifecycle } = await import('../../../lib/wsFrameBus');
      subscribeLifecycle((event) => {
        if (event !== 'close') return;
        // La riga sul server può essere cambiata mentre eravamo scollegati (un
        // altro dispositivo, un'altra scheda), quindi «uguale all'ultimo che ha
        // accettato» non descrive più niente: si riparte dal mandare.
        forgetSynced();
        for (const entry of inflight.values()) entry.controller.abort();
        inflight.clear();
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      });
    })();
  }

  // Capability, not existence: a partial `window` stub (unit tests) satisfies
  // the `undefined` check but has no addEventListener.
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    // pagehide → beacon (page is terminating; response can't be read anyway).
    // visibilitychange hidden → keepalive fetch (tab may resume and receive the
    // WS echo of this write, so we MUST parse server_seq for the self-echo
    // contract — without it, HYDRATE re-applies and clobbers interim edits).
    //
    // Review-round-12 C1 (double-flush dedupe): On a real tab close,
    // `visibilitychange(hidden)` fires first, then `pagehide`. Both ran a
    // full flush — two PUTs for the same seq. The server LWW collapsed them,
    // but it doubled load and muddied telemetry. We now track the seq we
    // last flushed on this teardown cycle and skip the beacon if the
    // keepalive already covered it. `lastSeq` rearms the guard whenever new
    // state is produced, so a *genuine* resume-then-hide cycle still flushes.
    let lastFlushedSeqOnHide = -1;
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden') return;
      const seq = usePaneStore.getState().lastSeq;
      if (seq === lastFlushedSeqOnHide) return;
      lastFlushedSeqOnHide = seq;
      flushNowKeepalive();
    });
    window.addEventListener('pagehide', () => {
      const seq = usePaneStore.getState().lastSeq;
      if (seq === lastFlushedSeqOnHide) return; // keepalive already covered it
      lastFlushedSeqOnHide = seq;
      flushNowBeacon();
    });
  }
}

export const PANE_STORE_REMOTE_KEY = REMOTE_KEY;

/**
 * Force-flush the current pane-store snapshot to the server, bypassing the
 * 500 ms debounce. Use sparingly — only when a state mutation MUST be
 * durable before the user is likely to reload (e.g. closing a browser
 * pane: if the pane id is still in the persisted snapshot at boot,
 * `<RemoteBrowserPanel>` mounts and `useNativeBrowser` re-creates the
 * server-side context from its persisted partition, "resurrecting" the
 * tab the user just closed). Cancels any pending debounce timer so the
 * forced PUT is the canonical write for this seq.
 *
 * Idempotent: if `hasReceivedServerHydrate` is false (boot guard) we
 * silently no-op; the regular debounce flow will catch up once hydration
 * completes. Returns the inflight promise so callers can `await` durability
 * if they need to (e.g. before a navigation), but most callers can fire-
 * and-forget.
 */
export function flushPaneStoreNow(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!hasReceivedServerHydrate()) return Promise.resolve();
  const state = usePaneStore.getState();
  const snap = selectSyncableSnapshot(state);
  return pushSnapshot(REMOTE_KEY, snap, state.lastSeq);
}

// ─── test-only exports ────────────────────────────────────────────────────
/** Test/diagnostic — returns the inflight entries keyed by remote key. */
export function __getInflightKeys(): string[] {
  return [...inflight.keys()];
}
/** Test-only — resets the inflight Map. */
export function __resetInflightForTests(): void {
  for (const entry of inflight.values()) entry.controller.abort();
  inflight.clear();
}
/** Test-only — directly invoke the inflight-aware PUT (bypasses debounce). */
export function __pushSnapshotForTests(
  key: string,
  snapshot: unknown,
  snapshotSeq: number,
  baseSeq?: number,
): Promise<void> {
  return pushSnapshot(key, snapshot, snapshotSeq, baseSeq);
}
/** Test-only — the URL a teardown flush would PUT to for a given base seq. */
export function __teardownFlushUrlForTests(baseServerSeq: number): string {
  return teardownFlushUrl(baseServerSeq);
}

/**
 * Test-only — la domanda «questo corpo il server ce l'ha già?».
 *
 * Esposta perché il comportamento che vale la pena difendere non è «esiste una
 * Map», è: uno stato fermo non produce scritture. Un test che spiasse la Map
 * direbbe come è fatto il rimedio; questo dice cosa promette.
 */
export function __isAlreadySyncedForTests(key: string, snapshot: unknown): boolean {
  return isAlreadySynced(key, syncIdentity(snapshot));
}

/** Test-only — riporta la memoria del sincronizzato allo stato di boot. */
export function __resetSyncedBodyForTests(): void {
  forgetSynced();
}
