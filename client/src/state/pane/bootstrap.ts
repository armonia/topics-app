/**
 * Pane-store bootstrap — wires legacy-storage hydration, the four persistence
 * transports (local/server/WS/cross-tab), and the 500 ms WS-latency GET fallback
 * against /api/ui-state into a single entry point called from main.tsx.
 *
 * Phase 30 PANE-01: every /api/ui-state access lives inside client/src/state/pane/.
 * The grep gate in tests/e2e/infra-validation.spec.ts asserts that outside this
 * directory no file references /api/ui-state, topics-open-panels, etc.
 *
 * main.tsx calls bootstrapPaneStore() once, synchronously, before React renders.
 *
 * Review I4: we no longer open a second WebSocket here. `useWebSocket` (owned
 * by App.tsx once React mounts) fans frames out via `wsFrameBus`; this module
 * just subscribes to that bus.
 */
import { hydrateFromLegacyStorage } from './migration/importLegacy';
import { scheduleBrowserDataStoreReap } from '../../lib/browserDataStoreReaper';
import { scheduleBrowserClaimHeartbeat } from '../../lib/browserClaimHeartbeat';
import {
  initLocalPersistence,
  initServerSync,
  initWSSync,
  initCrossTabSync,
  hydrateFromLocalSnapshot,
  type WSFrame,
} from './middleware';
import { isSelfEcho } from './middleware/selfEcho';
import {
  hasReceivedServerHydrate,
  markServerHydrated,
} from './middleware/serverHydrated';
import { usePaneStore } from './store';
import { paneTypesToWarm, panesOnFirstFrame, preloadPaneChunks } from './panePreload';
import { subscribeFrames } from '../../lib/wsFrameBus';
import { initTombstoneSync } from './adapters/tombstoneSync';

/**
 * Thin adapter: conform `subscribeFrames` (untyped frame) to the
 * `initWSSync(onFrame)` contract (`WSFrame` = `{type: string}` + extras).
 * Passes a `types` whitelist so high-frequency chat/stream/ping frames never
 * reach the pane-store middleware — the bus filters in-place per review I1.
 * Only frames matching one of these types can reach the handler.
 */
// Review-round-12 B5: `ui-state:patch` MUST be on this whitelist — the server
// broadcasts it from bulk PUT (server/routes/ui-state.ts finding #11) and
// syncWS narrows on it at runtime. Without it in the whitelist, the frame bus
// filters patches out before they ever reach the middleware, so bulk PUTs from
// other tabs never hydrate this tab until the next full reconnect.
const PANE_STORE_WS_FRAME_TYPES = ['ui-state:init', 'ui-state:updated', 'ui-state:patch'] as const;

function subscribePaneStoreFrames(handler: (frame: WSFrame) => void): () => void {
  return subscribeFrames(
    (raw) => {
      // Bus whitelist (above) already guaranteed raw.type is one of the listed
      // strings, so this cast is safe. Keep the defensive null-check for
      // extreme edge cases (e.g. a test dispatching an odd payload).
      if (!raw || typeof raw !== 'object') return;
      handler(raw as WSFrame);
    },
    { types: PANE_STORE_WS_FRAME_TYPES },
  );
}

/**
 * When the first attempt leaves, and how long the waits between attempts grow
 * to. The first one stays at 500 ms: it is the WS latency this fallback covers.
 * The rest double from one second and stop at fifteen.
 */
const FALLBACK_FIRST_DELAY_MS = 500;
const FALLBACK_RETRY_BASE_MS = 1000;
const FALLBACK_RETRY_CEILING_MS = 15_000;
/** After how many empty attempts it says, once, what is not happening. */
const FALLBACK_WARN_AFTER_ATTEMPTS = 4;

/**
 * The attempt waiting to fire. In production nobody cancels it - the ladder
 * lives as long as the page - but a TEST that ends with a retry still armed
 * lets it fire inside the NEXT test, against that test's `fetch` stub: exactly
 * the shape of red that changes target every run in this repository. That is
 * what `__stopInitialLoadFallbackForTests` is for.
 */
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * The outcome of one fallback read.
 *
 *  · `answered` = the server DID answer about this key. Including "I do not
 *    have it": that is an answer too, and in this direction it is all we need.
 *  · `unknown`  = nothing is known. Network down, a 5xx, a body that will not
 *    parse. Do not hydrate, and try again.
 *
 * THE DISTINCTION IS THE MOST DELICATE THING IN THIS FILE. `markServerHydrated()`
 * opens the gate that holds back EVERY write towards the server: the debounced
 * PUT of `initServerSync`, the `keepalive` teardown flush, the `pagehide`
 * beacon. That gate exists because of a real failure, written down in
 * `syncServer.ts`: a reload storm that PUT the empty default snapshot over the
 * server's good copy and wiped the open tabs. So "hydrated" has to mean "the
 * server ANSWERED", never "I tried".
 */
type FallbackOutcome = 'answered' | 'unknown';

/**
 * Fallback to GET /api/ui-state if the WS `ui-state:init` frame has not
 * arrived. Per CONTEXT.md §Sync strategy initial-load priority step 3: the
 * syncWS middleware's lastAppliedServerSeq guard ensures any later WS init
 * frame is only applied if it carries a higher server_seq, so this fallback
 * races safely.
 *
 * PR-review #14: the suppression gate is `hasReceivedServerHydrate()` — a
 * module-level flag set ONLY by (a) syncWS on a valid ui-state:init /
 * ui-state:updated, (b) this fallback itself when the server answers.
 * Previously we gated on `state.lastSeq > 0`, which bumps for any local
 * dispatch (e.g. an early `OPEN_PANE`), so if the WS was down we'd suppress
 * the fallback and render an empty UI. Local dispatches must not be treated as
 * server hydrate.
 */
async function readServerSnapshot(): Promise<FallbackOutcome> {
  let res: Response;
  try {
    // The ONE key this fallback reads, not the whole store: `GET /api/ui-state`
    // is every key of every device (413 keys, 276 KB on the desktop measured
    // 2026-09-05, a third of it a heap-probe result), and it was queued at boot
    // next to the chat history on the same six connections. The single-key
    // route answers with `{ value, payload_version, server_seq }`.
    res = await fetch('/api/ui-state/pane-store-v2');
  } catch {
    // No answer at all: nothing is known, so nothing is hydrated.
    return 'unknown';
  }

  // A KEY NEVER WRITTEN IS AN ANSWER, and until now it was one for nobody.
  //
  // Measured against the live server on 2026-09-10: `GET /api/ui-state/<a key
  // that does not exist>` answers 200 with a `null` body
  // (`server/routes/ui-state.ts`, `if (!row) return json(null)`), not 404. The
  // old line read `envelope.value` off that `null` and threw a TypeError
  // straight into the outer `catch`: the fallback died in silence and
  // `markServerHydrated()` never fired. Nor did it fire from the WS, because
  // `syncWS` returns early (`if (value == null || !metaEntry) return`) in
  // exactly the case where the key is missing. So on a NEW device NOTHING ever
  // raised the flag: for the whole session no pane state reached the server,
  // the teardown flushes left through their `return`, and `syncServer`'s push
  // re-armed itself every 500 ms for ever without a word.
  //
  // The 404 shares this branch and is not a defence against nothing: it would
  // be the answer of a server that does not have this ROUTE, and then the PUT
  // does not exist either - in both cases there is nothing to trample.
  //
  // WHY HYDRATING HERE IS SAFE, which is the real question. The gate protects
  // the server's copy: if the server says there is no copy, there is nothing
  // to protect, and the snapshot that will leave is this device's LOCAL one
  // (`hydrateFromLocalSnapshot`, before the first render), not the empty
  // default. One race is left - another client writing the row between our GET
  // and our PUT - and compare-and-swap closes it: `pushSnapshot` sends
  // `?base=<lastServerSeq>` (0 when nothing has hydrated anywhere) and the
  // server refuses with 409 `stale_base` if the row moved in the meantime
  // (`server/routes/ui-state.ts`: "An absent row reads as seq 0, so a first
  // write declares base=0").
  if (res.status === 404) {
    markServerHydrated();
    return 'answered';
  }
  // Everything else that is not 2xx - a 5xx, a 400, a proxy in the middle - is
  // "I do not know": the server may well be holding the good row.
  if (!res.ok) return 'unknown';

  let envelope: { value?: unknown; server_seq?: number } | null;
  try {
    envelope = (await res.json()) as { value?: unknown; server_seq?: number } | null;
  } catch {
    // A body that will not parse says nothing about whether the row exists:
    // same category as a 5xx, and for the same reason it does not hydrate.
    return 'unknown';
  }

  const snap = envelope?.value;
  const seq = envelope?.server_seq ?? 0;
  // A successful GET — even one we decide not to apply (self-echo of our own
  // PUT), even one that came back empty — proves the server is reachable and
  // authoritative for this tab.
  markServerHydrated();
  // B2: if the server snapshot is the echo of a PUT this client just wrote
  // (race with an already-acked in-flight write), skip — local state is
  // already at or ahead of this seq.
  if (snap && !isSelfEcho(seq)) {
    usePaneStore.getState().dispatch({
      type: 'HYDRATE_FROM_SNAPSHOT',
      payload: {
        snapshot: {
          ...(snap as object),
          lastSeq: Math.max(usePaneStore.getState().lastSeq, seq),
          server_seq: seq,
          seq,
        },
      },
    });
  }
  return 'answered';
}

/**
 * The fallback, RETRYABLE. It was one-shot: a `!res.ok` simply returned, and
 * from there on nobody tried again - and the WS cannot make up for it, because
 * a `ui-state:init` without the key does not hydrate (see above). Now it
 * retries on a doubling wait, and stops only once somebody has really
 * hydrated: the ceiling SLOWS DOWN, it does not switch off, because the case
 * being escaped is "the server comes back in ten minutes".
 */
function scheduleInitialLoadFallback(attempt = 0): void {
  const delay = attempt === 0
    ? FALLBACK_FIRST_DELAY_MS
    : Math.min(FALLBACK_RETRY_BASE_MS * 2 ** (attempt - 1), FALLBACK_RETRY_CEILING_MS);
  fallbackTimer = setTimeout(async () => {
    fallbackTimer = null;
    // The WS may have hydrated in the meantime: then there is nothing left to
    // do here.
    if (hasReceivedServerHydrate()) return;
    if (await readServerSnapshot() === 'answered') return;
    // ONCE, AND IT SAYS WHAT IS NOT HAPPENING. This state used to be mute: no
    // pane state reaches the server, the teardown flushes leave through their
    // `return`, and `syncServer`'s push re-arms every 500 ms waiting for a
    // hydration that never comes. One line in the console is what turns "the
    // app forgot my tabs" into a diagnosis.
    if (attempt === FALLBACK_WARN_AFTER_ATTEMPTS) {
      console.warn(
        '[pane-store] the server has not answered for pane-store-v2 after %d attempts: '
        + 'nothing this tab does to its panes is reaching the server, and the teardown '
        + 'flush stays disabled until it does. Still retrying.',
        attempt + 1,
      );
    }
    scheduleInitialLoadFallback(attempt + 1);
  }, delay);
}

/** Settles when the chunks of the panes on screen have been evaluated. */
let chunksWarm: Promise<void> = Promise.resolve();

/**
 * The promise the first render waits on (with a cap): the chunks of every pane
 * the local snapshot says is open. Resolved already when nothing is open.
 */
export function paneChunksWarm(): Promise<void> {
  return chunksWarm;
}

/**
 * Bootstrap the pane store. Call exactly once at app module load, before React
 * renders. Idempotent via each init*()'s internal `started` flag.
 */
export function bootstrapPaneStore(): void {
  // Detached pop-out windows (`?topics=a,b` / legacy `?topic=`) host exactly
  // the topics in their URL and must be READ-ONLY toward the shared pane
  // store: they still hydrate (local snapshot + WS/HTTP) so panes render, but
  // never write back — no server PUT, no cross-tab broadcast, no local
  // snapshot overwrite, no tombstone mirroring, no legacy-key clearing. A
  // detached window that persisted its dispatches leaked its panes into every
  // other client's layout (live incident 2026-07-20: automation windows in
  // detached mode stranded nine floating browser panes in group:default).
  const params = new URLSearchParams(window.location.search);
  const detachedList = params.get('topics') ?? params.get('topic');
  const isDetached = Boolean(detachedList);

  // Seed the reducer from legacy localStorage (one-shot; also clears legacy keys).
  if (!isDetached) hydrateFromLegacyStorage();

  // Warm-hydrate from the same-device `pane-store-v2` snapshot BEFORE React
  // renders. Closes the ~500 ms gap between mount and the WS/HTTP server
  // hydrate landing, during which `openPanels` would otherwise start empty
  // and the focus-keeper effects would snap focus to `storeOrder[0]`.
  // Server hydrate still wins LWW via syncWS's lastAppliedServerSeq guard.
  hydrateFromLocalSnapshot();

  // The snapshot just told us WHICH KINDS of pane are on screen, and every pane
  // body is a lazy chunk. Ask for those chunks now, in parallel with the rest
  // of the boot, instead of after React has mounted and hit the suspense
  // boundary: that wait was 222-347 ms of spinner on a reload, and it was the
  // same figure for the board, the editor and the terminal, because it was
  // never their data - it was their code. See `panePreload.ts`. The tiles a
  // project window persisted in its own local record count as open panes too.
  //
  // ON SCREEN, not "in the account". This used to read every pane in the store,
  // which is the union of every Spazio and of every window's layout; the first
  // frame draws one of them. `panesOnFirstFrame` narrows it to what this window
  // will actually render — its hosted topics if it is a pop-out, otherwise
  // `group:default` filtered to the Spazio the hydrate above has just restored
  // (query first in a group window, see `persistLocal`). Everything else keeps
  // loading lazily on its first mount, exactly as a never-opened pane always did.
  const hostedPaneIds = detachedList
    ? detachedList.split(',').map((id) => id.trim()).filter(Boolean)
    : null;
  chunksWarm = preloadPaneChunks(paneTypesToWarm(
    panesOnFirstFrame(usePaneStore.getState(), hostedPaneIds),
    (key) => {
      try { return localStorage.getItem(key); } catch { return null; }
    },
  ));

  // Wire the persistence subscribers (write paths gated on detached above).
  if (!isDetached) {
    initLocalPersistence();
    initServerSync();
    initCrossTabSync();
  }
  // Subscribe to the app's single WS via the module-level frame bus. When
  // React later mounts and useWebSocket opens the socket, frames flow into
  // `dispatchFrame` and fan out to every subscriber registered here.
  initWSSync(subscribePaneStoreFrames);

  // Cross-device mirroring of browser/terminal close-tombstones over the same
  // ui_state channel (union-only, clobber-safe). Wired after the frame bus so
  // its subscribeFrames registration is in place before the socket opens.
  if (!isDetached) initTombstoneSync();

  // 500 ms WS-latency fallback to GET /api/ui-state.
  scheduleInitialLoadFallback();

  // Lo spazzino degli store browser orfani (Tauri, differito di 90 s). Non
  // dalle finestre staccate: sono READ-ONLY verso lo stato condiviso, e questo
  // è il gesto meno reversibile che ci sia — due finestre che grattano lo
  // stesso disco insieme, poi, non aggiungono niente.
  if (!isDetached) scheduleBrowserDataStoreReap();

  // Il battito che rivendica le pane browser di questa finestra. Senza il
  // guard `isDetached`, e non per svista: una finestra staccata OSPITA pane
  // browser, e il suo reclamo è esattamente ciò che le tiene aperte. Zittirla
  // qui vorrebbe dire far chiudere al Rust le webview che sta mostrando.
  // Non è una scrittura sullo stato condiviso, quindi il read-only del
  // pop-out resta intatto: dice solo cosa vive dentro questa pagina.
  scheduleBrowserClaimHeartbeat();
}

/**
 * Test-only — invoke the fallback schedule without wiring the full bootstrap.
 * The 500 ms timer runs as in production; tests fake the timer.
 */
export function __scheduleInitialLoadFallbackForTests(): void {
  scheduleInitialLoadFallback();
}

/** Test-only — disarm a pending retry so it cannot fire inside the next case. */
export function __stopInitialLoadFallbackForTests(): void {
  if (fallbackTimer !== null) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
}

