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
 * NOTA — QUI VIVEVA UN GATE ANTI-RISCRITTURA, ed è stato ritirato di proposito.
 *
 * L'idea era: se lo snapshot da mandare è identico all'ultimo che il server ha
 * accettato, non mandarlo. Serviva a fermare un ciclo reale — una finestra
 * ferma PUT-tava 75 KB ogni 1,15 s — e nei test unitari funzionava.
 *
 * Sul campo no, e la ragione è che questo middleware NON è l'unico scrittore
 * della riga: `flushPaneStoreNow` (chiusura di una pane browser), i flush di
 * teardown e le idratazioni dal server toccano tutti lo stesso stato con
 * tempistiche proprie. Una memoria di «cosa ha il server» tenuta da uno solo
 * di quei percorsi finiva per parlare anche per gli altri, e il PUT successivo
 * veniva saltato per somiglianza con un corpo che non era il suo.
 *
 * Il prezzo non era un byte: era una CHIUSURA DI SCHEDA che non arrivava al
 * server — `pane-undo.spec.ts` rosso su «closedStack must have at least one
 * entry after CLOSE_PANE», mentre lo stesso test passava su un albero
 * costruito al commit precedente. Tre tentativi di rattoppo (registrare solo
 * dopo l'ack, registrare solo dal percorso del debounce, invalidare a ogni
 * idratazione) hanno spostato il difetto senza toglierlo; togliendo il gate il
 * test torna verde.
 *
 * IL CICLO RESTA CHIUSO LO STESSO, perché la causa vera era a monte:
 * `UPDATE_PANE` produceva un oggetto nuovo anche a valori identici, e ora non
 * lo fa (`reducers/panes.ts`). Senza quel dispatch a vuoto `lastSeq` non si
 * muove, il debounce non parte, e non c'è niente da filtrare qui.
 * `scripts/check-idle-writes.mjs` misura zero scritture a riposo con la sola
 * guardia del reducer.
 *
 * Se un giorno servisse davvero un gate qui, la lezione è che deve conoscere
 * TUTTI gli scrittori della chiave, non solo questo.
 */

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
        // QUI HO PROVATO UN GATE, E L'HO RITIRATO. La seconda volta oggi, e la
        // ragione e' la stessa: questo punto sembra il posto giusto per dire
        // «non rimandare cio' che il server ha gia'», e non lo e'.
        //
        // Il ciclo e' reale e misurato: `lastSeq` sale anche su un'idratazione
        // REMOTA (il reducer lo porta a `max(lastSeq, clean.lastSeq)`, e
        // `clean.lastSeq` viene da un `server_seq` che cresce con le scritture
        // di CHIUNQUE — ventuno sessioni aperte su questa macchina), quindi
        // questo timer si arma anche quando lo stato non e' cambiato di un
        // byte: 12-17 PUT da 75 KB in 25 secondi a schermo fermo, uno per ogni
        // `HYDRATE_FROM_SNAPSHOT` ricevuto, contati strumentando il dispatcher.
        //
        // Il rimedio (confrontare cio' che si sta per mandare con l'identita'
        // dell'ultimo stato IDRATATO) porta il cancello a ZERO scritture, su tre
        // giri. Ma rompe `cross-window-topic-sync`: aprire una chat e ricaricare
        // non la ritrova piu' aperta. Verificato che il rosso sia mio —
        // disattivando la sola riga del gate quel test torna verde.
        //
        // Perche' non l'ho forzato: il beneficio e' banda e un po' di event
        // loop; il costo e' uno stato che non si sincronizza, cioe' lavoro
        // perso a schermo. Fra i due, il secondo e' peggiore del difetto che
        // toglie — e oggi ho gia' pagato questa lezione con un gate che faceva
        // sparire la chiusura di una scheda.
        //
        // Dove guarderei ripartendo: non qui, ma in `syncWS.ts`, alla riga che
        // porta `lastSeq` a `max(currentSeq, server_seq)` su un'idratazione. E'
        // quella a trasformare la scrittura di un pari nel nostro contatore, e
        // finche' resta cosi' ogni gate a valle sta rattoppando un sintomo.
        // Gli agganci restano pubblicati (`alreadyOnServer`, `noteLocalWrite`)
        // con i loro commenti: servono a chi riprende, non a questo giro.
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


