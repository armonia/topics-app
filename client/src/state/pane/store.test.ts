import { describe, test, expect, beforeEach } from "bun:test";
import { usePaneStore } from "./store";
import { DEFAULT_SPACE_ID } from "./types";

// Reset the singleton store between tests — it's a module-level Zustand
// instance, so its state leaks across assertions without an explicit reset.
function resetStore(): void {
  usePaneStore.setState({
    panes: {},
    groups: {},
    closedStack: [],
    focusedPaneId: null,
    groupOrder: [],
    spaces: {},
    activeSpaceId: DEFAULT_SPACE_ID,
    lastSeq: 0,
    lastServerSeq: 0,
  });
}

describe("usePaneStore.setPaneScrollOffset (PANE-03 device-local setter)", () => {
  beforeEach(resetStore);

  test("writes scrollOffset onto the pane entity", () => {
    usePaneStore.getState().dispatch({
      type: "OPEN_PANE",
      payload: { id: "chat:t1", type: "chat", title: "A", groupId: "g1" },
    });
    const seqBefore = usePaneStore.getState().lastSeq;

    usePaneStore.getState().setPaneScrollOffset("chat:t1", 250);

    expect(usePaneStore.getState().panes["chat:t1"].scrollOffset).toBe(250);
    // Device-local write must NOT bump lastSeq — otherwise syncServer fires
    // on every scroll tick (review I1 invariant).
    expect(usePaneStore.getState().lastSeq).toBe(seqBefore);
  });

  test("rejects negative and non-finite offsets without touching state", () => {
    usePaneStore.getState().dispatch({
      type: "OPEN_PANE",
      payload: { id: "chat:t1", type: "chat", title: "A", groupId: "g1" },
    });

    usePaneStore.getState().setPaneScrollOffset("chat:t1", -5);
    expect(usePaneStore.getState().panes["chat:t1"].scrollOffset).toBeUndefined();

    usePaneStore.getState().setPaneScrollOffset("chat:t1", NaN);
    expect(usePaneStore.getState().panes["chat:t1"].scrollOffset).toBeUndefined();

    usePaneStore.getState().setPaneScrollOffset("chat:t1", Infinity);
    expect(usePaneStore.getState().panes["chat:t1"].scrollOffset).toBeUndefined();
  });

  test("no-ops when the pane id does not exist", () => {
    const before = { ...usePaneStore.getState().panes };
    usePaneStore.getState().setPaneScrollOffset("chat:ghost", 100);
    expect(usePaneStore.getState().panes).toEqual(before);
  });

  test("repeated calls for a missing paneId stay idempotent (dev warn dedupe)", () => {
    // Review I2 (round-7): a throttled scroll handler at 250 ms during a
    // racy mount fires setPaneScrollOffset before OPEN_PANE. The previous
    // implementation warned on every call; now the warn is deduped by
    // paneId. We can't reliably stub console in bun:test across versions,
    // so assert the observable behavior: state stays clean across N calls.
    const seqBefore = usePaneStore.getState().lastSeq;
    usePaneStore.getState().setPaneScrollOffset("chat:ghost", 100);
    usePaneStore.getState().setPaneScrollOffset("chat:ghost", 200);
    usePaneStore.getState().setPaneScrollOffset("chat:ghost", 300);

    expect(usePaneStore.getState().panes["chat:ghost"]).toBeUndefined();
    // Device-local setter must never bump lastSeq — even on a missing id.
    expect(usePaneStore.getState().lastSeq).toBe(seqBefore);
  });
});

describe("usePaneStore.dispatch (lastSeq monotonicity)", () => {
  beforeEach(resetStore);

  test("each dispatch advances lastSeq by exactly 1 after CLOSE_PANE fix", () => {
    usePaneStore.getState().dispatch({
      type: "OPEN_PANE",
      payload: { id: "chat:t1", type: "chat", title: "A", groupId: "g1" },
    });
    const afterOpen = usePaneStore.getState().lastSeq;

    usePaneStore.getState().dispatch({
      type: "CLOSE_PANE",
      payload: { id: "chat:t1", groupId: "g1", groupIndex: 0 },
    });
    const afterClose = usePaneStore.getState().lastSeq;

    // Without the review-round-2 I3 fix, close bumped lastSeq twice
    // (reducer + dispatcher). After the fix, it advances by exactly one.
    expect(afterClose).toBe(afterOpen + 1);
    // The ClosedPaneRecord seq should match the new lastSeq.
    const rec = usePaneStore.getState().closedStack[0];
    expect(rec.seq).toBe(afterClose);
  });

  test("l'arrivo dello stato di un PARI non conta come una nostra modifica", () => {
    // È l'invariante che chiude il ciclo di scritture a riposo, misurato a 27
    // PUT in 30 secondi con lo schermo fermo.
    //
    // Il meccanismo: `lastSeq` DEVE salire su un hydrate (il reducer lo porta a
    // `max(lastSeq, clean.lastSeq)`, altrimenti le PUT successive nascono con
    // un seq che il server considera vecchio). Ma il middleware di sync usava
    // proprio `lastSeq` come sveglia, quindi il frame di un pari lo svegliava:
    // mezzo secondo dopo rimandava 75 KB identici a quelli appena ricevuti,
    // quel PUT alzava `server_seq`, il server ritrasmetteva, il pari faceva lo
    // stesso. Serve piu' di una finestra per vederlo — con una sola non gira, ed
    // e' il motivo per cui ogni misura precedente leggeva «0 scritture».
    //
    // `localSeq` risponde all'altra domanda: non «il contatore si e' mosso» ma
    // «ci siamo mossi NOI».
    const serverSeq = 2_000_000;
    const primaLocal = usePaneStore.getState().localSeq;

    usePaneStore.getState().dispatch({
      type: "HYDRATE_FROM_SNAPSHOT",
      payload: {
        snapshot: {
          seq: serverSeq, server_seq: serverSeq, lastSeq: serverSeq,
          panes: {}, groups: {}, closedStack: [],
        },
      },
    });

    const dopo = usePaneStore.getState();
    // `lastSeq` sale: serve a tenere fresche le PUT successive, e toglierlo
    // romperebbe la sincronizzazione (e' cio' che due rimedi ritirati facevano).
    expect(dopo.lastSeq).toBe(serverSeq);
    // `localSeq` NO: nessuno su questo dispositivo ha cambiato niente.
    expect(dopo.localSeq).toBe(primaLocal);
  });

  test("una modifica NOSTRA alza localSeq — il canale non e' stato zittito", () => {
    // L'altra meta' dell'invariante, e la piu' importante da difendere: un
    // cancello che porta le scritture a zero smettendo di sincronizzare non ha
    // risolto niente, ha spostato il danno su qualcosa che si nota di piu'.
    // Due tentativi precedenti sono stati ritirati esattamente per questo.
    const prima = usePaneStore.getState().localSeq;
    usePaneStore.getState().dispatch({
      type: "OPEN_PANE",
      payload: { id: "chat:mio", type: "chat", title: "M", groupId: "g1" },
    });
    expect(usePaneStore.getState().localSeq).toBe(prima + 1);
  });

  test("HYDRATE carrying a spaces registry stays server-authoritative (I1: no dispatcher lastSeq bump)", () => {
    // Enlarging the snapshot with `spaces` must not change HYDRATE's
    // classification: the reducer installs the payload's lastSeq verbatim
    // and the dispatcher must NOT increment past it, or the next WS
    // broadcast at the same server_seq is dropped by the LWW gate.
    // Far above anything the module-level `_seq` counter could have reached
    // in this file — the assertion below must observe the INSTALLED value.
    const serverSeq = 1_000_000;
    usePaneStore.getState().dispatch({
      type: "HYDRATE_FROM_SNAPSHOT",
      payload: {
        snapshot: {
          seq: serverSeq,
          server_seq: serverSeq,
          lastSeq: serverSeq,
          panes: {},
          groups: {},
          closedStack: [],
          spaces: {
            "space:a": { id: "space:a", name: "Lavoro", order: 0, updatedAt: 10 },
          },
        },
      },
    });
    const s = usePaneStore.getState();
    expect(s.spaces["space:a"]).toBeDefined();
    // Server-authoritative: lastSeq === the installed value, NOT value + 1.
    expect(s.lastSeq).toBe(serverSeq);
    expect(s.lastServerSeq).toBe(serverSeq);
  });

  test("SET_ACTIVE_SPACE is a plain local dispatch (bumps lastSeq — FOCUS_PANE precedent)", () => {
    usePaneStore.setState({
      spaces: { "space:a": { id: "space:a", name: "A", order: 0, updatedAt: 1 } },
    });
    // Align the store's lastSeq with the module-level `_seq` counter (it is
    // never reset between tests) so the +1 assertion is exact.
    usePaneStore.getState().dispatch({ type: "FOCUS_PANE", payload: { id: null } });
    const before = usePaneStore.getState().lastSeq;
    usePaneStore.getState().dispatch({ type: "SET_ACTIVE_SPACE", payload: { id: "space:a" } });
    const s = usePaneStore.getState();
    expect(s.activeSpaceId).toBe("space:a");
    expect(s.lastSeq).toBe(before + 1);
  });
});
