/**
 * Tests for syncWS — the WS subscriber that applies server broadcasts under the
 * LWW `lastAppliedServerSeq` gate. This is the only pane middleware that was
 * shipping without a test, yet it's the one that mutates local pane state from
 * remote frames: a regression here silently corrupts multi-device state.
 *
 * Scope (test-only, no product change):
 *   (a) monotonic seq gate — a frame with server_seq <= lastApplied is dropped;
 *   (b) self-echo suppression — echoes of our own PUT never re-hydrate;
 *   (c) init-vs-delta ordering — the same gate spans init AND updated frames,
 *       so a stale init arriving after a newer updated never clobbers state.
 *
 * Setup mirrors the sibling middleware tests (syncServer/selfEcho): a minimal
 * fake `window`/`localStorage` so the transitive imports load under bun:test,
 * and a stubbed `usePaneStore.getState` so we can observe every dispatch
 * without spinning up the real reducer.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";

// syncCrossTab (pulled in transitively) reads window/localStorage lazily — give
// it a harmless shim so module load doesn't blow up. See syncServer.test.ts.
type StorageArea = Record<string, string>;
function installFakeWindow(): void {
  const store: StorageArea = Object.create(null);
  const storageApi = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  };
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: storageApi,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  (globalThis as unknown as { localStorage: unknown }).localStorage = storageApi;
}

installFakeWindow();

const { initWSSync, __getLastAppliedServerSeq, alreadyOnServer, noteLocalWrite } = await import("./syncWS");
const { rememberLocalAck, __resetSelfEchoForTests } = await import("./selfEcho");
const { getTabId } = await import("./syncCrossTab");
const { dispatchLifecycle } = await import("../../../lib/wsFrameBus");
const { usePaneStore } = await import("../store");

const REMOTE_KEY = "pane-store-v2";

type WSFrame = { type: string; [k: string]: unknown };

function updatedFrame(seq: number, extra?: Record<string, unknown>): WSFrame {
  return { type: "ui-state:updated", key: REMOTE_KEY, value: {}, server_seq: seq, ...extra };
}
function initFrame(seq: number): WSFrame {
  return {
    type: "ui-state:init",
    data: { [REMOTE_KEY]: {} },
    meta: { [REMOTE_KEY]: { payload_version: 1, server_seq: seq } },
  };
}

describe("syncWS — LWW gate on server broadcasts", () => {
  let dispatched: Array<{ type: string; payload?: unknown }>;
  let send: (frame: WSFrame) => void;
  let cleanup: () => void;
  const realGetState = usePaneStore.getState;

  beforeEach(() => {
    __resetSelfEchoForTests();
    dispatched = [];
    // Stub the store so we observe dispatches without invoking the real reducer.
    (usePaneStore as unknown as { getState: () => unknown }).getState = () => ({
      lastSeq: 0,
      dispatch: (action: { type: string; payload?: unknown }) => dispatched.push(action),
    });

    let handler: ((f: WSFrame) => void) | undefined;
    cleanup = initWSSync((h) => { handler = h; return () => {}; });
    send = (f) => handler?.(f);

    // The lifecycle 'open' handler registered by initWSSync resets both the
    // monotonic gate (lastAppliedServerSeq → 0) and selfEcho, giving each test
    // a clean per-connection baseline despite the module-level state.
    dispatchLifecycle("open");
  });

  afterEach(() => {
    cleanup();
    (usePaneStore as unknown as { getState: unknown }).getState = realGetState;
  });

  test("(a) drops updated frames with seq <= lastApplied, applies strictly-newer ones", () => {
    send(updatedFrame(5));
    expect(dispatched.length).toBe(1);
    expect(dispatched[0].type).toBe("HYDRATE_FROM_SNAPSHOT");
    expect(__getLastAppliedServerSeq()).toBe(5);

    // Older frame → ignored.
    send(updatedFrame(3));
    expect(dispatched.length).toBe(1);
    expect(__getLastAppliedServerSeq()).toBe(5);

    // Equal seq → ignored (gate is strict `>`).
    send(updatedFrame(5));
    expect(dispatched.length).toBe(1);

    // Strictly newer → applied.
    send(updatedFrame(6));
    expect(dispatched.length).toBe(2);
    expect(__getLastAppliedServerSeq()).toBe(6);
    expect((dispatched[1].payload as { snapshot: { server_seq: number } }).snapshot.server_seq).toBe(6);
  });

  test("(b) suppresses self-echo but still advances the gate", () => {
    // Our own outbound PUT acked at seq 10; the broadcast echoes back.
    rememberLocalAck(10);
    send(updatedFrame(10));
    // Echo must NOT re-hydrate local state...
    expect(dispatched.length).toBe(0);
    // ...but the gate advances so later real frames at the same seq are dropped.
    expect(__getLastAppliedServerSeq()).toBe(10);

    send(updatedFrame(10));
    expect(dispatched.length).toBe(0);
  });

  test("(b) sourceClientId matching our tab is dropped (defence-in-depth)", () => {
    send(updatedFrame(7, { sourceClientId: getTabId() }));
    expect(dispatched.length).toBe(0);
    // Gate advanced even though nothing was applied.
    expect(__getLastAppliedServerSeq()).toBe(7);
  });

  test("(c) the gate spans init AND updated: a stale init after a newer updated is ignored", () => {
    // A remote delta lands at seq 10.
    send(updatedFrame(10));
    expect(dispatched.length).toBe(1);
    expect(__getLastAppliedServerSeq()).toBe(10);

    // A late-arriving init at seq 8 (e.g. reordered on the wire) must NOT clobber.
    send(initFrame(8));
    expect(dispatched.length).toBe(1);
    expect(__getLastAppliedServerSeq()).toBe(10);

    // A newer init (seq 12) does apply, and a subsequent older delta is dropped.
    send(initFrame(12));
    expect(dispatched.length).toBe(2);
    expect(dispatched[1].type).toBe("HYDRATE_FROM_SNAPSHOT");
    expect((dispatched[1].payload as { snapshot: { server_seq: number } }).snapshot.server_seq).toBe(12);

    send(updatedFrame(11));
    expect(dispatched.length).toBe(2);
    expect(__getLastAppliedServerSeq()).toBe(12);
  });

  test("init applies on a fresh connection and seeds the gate", () => {
    send(initFrame(2));
    expect(dispatched.length).toBe(1);
    expect(dispatched[0].type).toBe("HYDRATE_FROM_SNAPSHOT");
    expect(__getLastAppliedServerSeq()).toBe(2);
  });
});

/**
 * L'AGGANCIO PARCHEGGIATO, e perche' ha un test invece di essere cancellato.
 *
 * `alreadyOnServer` / `noteLocalWrite` sono il rimedio al ciclo di scritture
 * (12-17 PUT da 75 KB in 25 secondi a schermo fermo). Funziona — porta il
 * cancello a zero scritture su tre giri — ma rompe `cross-window-topic-sync`,
 * quindi il 19/08 e' stato lasciato FUORI di proposito: `syncServer.ts:414`
 * scrive il verdetto per intero, compresa la riga dove guarderebbe chi riprende.
 *
 * Il lato SCRITTURA pero' e' vivo: `syncWS.ts:265` e `:305` registrano
 * l'identita' a ogni idratazione. Il lato LETTURA non aveva chiamanti, e quello
 * e' il modo in cui un meccanismo conservato marcisce senza che nessuno se ne
 * accorga — resta compilabile, smette di essere vero, e chi lo riprende fra sei
 * mesi eredita del codice che sembra pronto e non lo e' piu'.
 *
 * Questi test sono quel chiamante. Non riaccendono il rimedio (nessun prodotto
 * cambia): fissano le tre proprieta' su cui si regge, cosi' che se qualcuno le
 * rompe passando di qui lo scopra subito e non chi ci torna dopo.
 */
describe("syncWS — l'aggancio parcheggiato: «questo il server ce l'ha gia'»", () => {
  let send: (frame: WSFrame) => void;
  let cleanup: () => void;
  const realGetState = usePaneStore.getState;

  beforeEach(() => {
    __resetSelfEchoForTests();
    (usePaneStore as unknown as { getState: () => unknown }).getState = () => ({
      lastSeq: 0,
      dispatch: () => {},
    });
    let handler: ((f: WSFrame) => void) | undefined;
    cleanup = initWSSync((h) => { handler = h; return () => {}; });
    send = (f) => handler?.(f);
    dispatchLifecycle("open");
    // `lastHydratedIdentity` e' stato di modulo e NON lo azzera il lifecycle:
    // lo azzera solo una scrittura locale, che e' esattamente la sua API.
    noteLocalWrite();
  });

  afterEach(() => {
    cleanup();
    (usePaneStore as unknown as { getState: unknown }).getState = realGetState;
  });

  test("senza un'idratazione recente dice NO — ed e' il verso giusto in cui sbagliare", () => {
    // Nessun frame ricevuto: qualunque cosa si stia per mandare, va mandata.
    // Sbagliare qui costa un PUT in piu'; sbagliare dall'altra parte costa uno
    // stato che non si sincronizza.
    expect(alreadyOnServer({ panes: { a: 1 } })).toBe(false);
    expect(alreadyOnServer({})).toBe(false);
  });

  test("dopo un frame del server riconosce quello stato, e solo quello", () => {
    send(updatedFrame(4, { value: { panes: { a: 1 }, lastSeq: 4 } }));
    expect(alreadyOnServer({ panes: { a: 1 }, lastSeq: 4 })).toBe(true);
    // Uno stato diverso non e' quello del server: senza questa meta' una
    // funzione che dicesse sempre «si'» passerebbe il test qui sopra.
    expect(alreadyOnServer({ panes: { a: 2 }, lastSeq: 4 })).toBe(false);
  });

  test("i due contatori di trasporto NON sono lo stato", () => {
    // `lastSeq`/`server_seq`/`seq` salgono per costruzione a ogni giro:
    // confrontarli direbbe «diverso» sempre, e non fermerebbe un solo PUT.
    // E' la proprieta' che si rompe per prima se qualcuno «pulisce» la
    // destrutturazione di `stateIdentity`.
    send(updatedFrame(4, { value: { panes: { a: 1 }, lastSeq: 4, server_seq: 4 } }));
    expect(alreadyOnServer({ panes: { a: 1 }, lastSeq: 999, server_seq: 12345, seq: 7 })).toBe(true);
  });

  test("una scrittura locale rimette il confronto a zero", () => {
    send(updatedFrame(4, { value: { panes: { a: 1 } } }));
    expect(alreadyOnServer({ panes: { a: 1 } })).toBe(true);
    noteLocalWrite();
    // Da qui in poi lo stato non e' piu' «quello che il server mi ha mandato»,
    // anche se per caso ne ha ripreso la forma.
    expect(alreadyOnServer({ panes: { a: 1 } })).toBe(false);
  });
});
