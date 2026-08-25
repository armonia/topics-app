/**
 * Lo scroll delle chat NON attraversa un ricaricamento — e questi test lo
 * pretendono, perché prima era il contrario.
 *
 * C'era una chiave device-local (`pane-store-scroll-offsets`) che riportava
 * ogni chat dove l'avevi lasciata. Sembra un servizio e non lo è: la posizione
 * invecchia nell'istante in cui arriva un messaggio, quindi riaprendo ti
 * deposita in mezzo al nulla — il «ricarico e si perde» segnalato più volte.
 * Lo stato di riposo di una chat è il fondo.
 *
 * Resta vivo `pane.scrollOffset` IN MEMORIA: serve all'undo di una pane chiusa,
 * che se lo porta dietro in `ClosedPaneRecord`.
 *
 * @covers TAB-SYNC-01
 */
import { describe, test, expect, beforeEach } from "bun:test";

// Fake window stub (same pattern as bootstrap.test.ts / syncCrossTab.test.ts).
function installFakeWindow(): void {
  const store: Record<string, string> = Object.create(null);
  const storageApi = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
  };
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: storageApi,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  (globalThis as unknown as { localStorage: unknown }).localStorage = storageApi;
}
installFakeWindow();

const { usePaneStore } = await import("../store");
const { hydrateFromLocalSnapshot, flushLocalPaneStoreNow } = await import("./persistLocal");

const SCROLL_KEY = "pane-store-scroll-offsets";

function mkPane(id: string) {
  return { id, type: "chat" as const, title: id };
}

function resetStore(): void {
  usePaneStore.setState({
    panes: {},
    groups: {},
    closedStack: [],
    tombstones: {},
    focusedPaneId: null,
    groupOrder: [],
    spaces: {},
    lastSeq: 0,
    lastServerSeq: 0,
  });
}

beforeEach(() => {
  localStorage.clear();
  resetStore();
});

describe("persistLocal — lo scroll delle chat non sopravvive al ricaricamento", () => {
  test("il flush non scrive nessuna mappa di posizioni", () => {
    usePaneStore.setState({
      panes: { "chat:a": { ...mkPane("chat:a"), scrollOffset: 300 } },
    });
    flushLocalPaneStoreNow();
    expect(localStorage.getItem(SCROLL_KEY)).toBeNull();
  });

  test("una mappa scritta da una versione PRECEDENTE non viene riapplicata", () => {
    // I dispositivi già in uso hanno la chiave vecchia nello storage: leggerla
    // rimetterebbe in piedi il difetto proprio su chi lo ha segnalato.
    localStorage.setItem(SCROLL_KEY, JSON.stringify({ "chat:a": 420 }));
    usePaneStore.setState({ panes: { "chat:a": mkPane("chat:a") } });

    hydrateFromLocalSnapshot();

    expect(usePaneStore.getState().panes["chat:a"].scrollOffset).toBeUndefined();
  });

  test("la posizione resta comunque disponibile IN MEMORIA per l'undo", () => {
    // È il canale dell'undo di una pane chiusa: quello continua a riaprire la
    // scheda esattamente com'era, e non passa da localStorage.
    usePaneStore.setState({ panes: { "chat:a": mkPane("chat:a") } });
    usePaneStore.getState().setPaneScrollOffset("chat:a", 420);
    expect(usePaneStore.getState().panes["chat:a"].scrollOffset).toBe(420);
  });
});
