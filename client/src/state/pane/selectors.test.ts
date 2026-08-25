import { describe, test, expect } from "bun:test";
import { selectSyncableSnapshot, selectLocalSnapshot, filterVisiblePaneIds, selectVisiblePaneIds, resolveBootFocus, hasVisiblePane } from "./selectors";
import type { PaneState, Pane, ClosedPaneRecord, SpaceMeta } from "./types";
import { DEFAULT_SPACE_ID } from "./types";
import { blankPaneState as blankState } from "./testSupport";

/**
 * Un registro di spazi VIVO, tipizzato.
 *
 * Era `{ … } as any`: il cast serviva solo a non scrivere `order` e `updatedAt`,
 * ma spegneva ogni controllo — se `SpaceMeta` cambiasse forma, questi due test
 * continuerebbero a compilare passando un oggetto che il codice vero non
 * accetterebbe mai.
 *
 * @covers TAB-SYNC-01
 */
const spaceRegistry = (id: string, name: string): Record<string, SpaceMeta> => ({
  [id]: { id, name, order: 0, updatedAt: 1 },
});


describe("selectSyncableSnapshot (PANE-02)", () => {
  test("strips BOTH outer and nested scrollOffset from closedStack records", () => {
    // Post-fix (device-local invariant): `ClosedPaneRecord.scrollOffset` is
    // also device-local — CLOSE_PANE no longer writes it, and the outbound
    // snapshot must not leak it either. CLOSE_PANE may have been dispatched
    // on a pre-fix client and left the value on an in-memory record; the
    // selector must strip it defensively.
    const state = blankState();
    const record: ClosedPaneRecord = {
      id: "chat:t2",
      closedAt: 1000,
      pane: { id: "chat:t2", type: "chat", title: "Bye", scrollOffset: 100 },
      groupId: "g1",
      groupIndex: 0,
      level: "app",
      focusedAtClose: false,
      tabOrderSnapshot: [],
      scrollOffset: 42, // outer — legacy value; must be stripped on outbound
      seq: 1,
    };
    state.closedStack = [record];

    const snapshot = selectSyncableSnapshot(state);

    // Nested pane.scrollOffset stripped
    expect(snapshot.closedStack[0].pane.scrollOffset).toBeUndefined();
    // Outer ClosedPaneRecord.scrollOffset also stripped
    expect(snapshot.closedStack[0].scrollOffset).toBeUndefined();
    // Other fields survive
    expect(snapshot.closedStack[0].id).toBe("chat:t2");
    expect(snapshot.closedStack[0].seq).toBe(1);
  });

  test("excludes focusedPaneId from snapshot", () => {
    const state = blankState();
    state.focusedPaneId = "chat:t1";

    const snapshot = selectSyncableSnapshot(state);

    expect((snapshot as Record<string, unknown>).focusedPaneId).toBeUndefined();
  });

  test("strips scrollOffset from top-level panes", () => {
    const state = blankState();
    state.panes["file:a"] = {
      id: "file:a",
      type: "file",
      title: "File A",
      scrollOffset: 300,
    };

    const snapshot = selectSyncableSnapshot(state);

    // Il tipo di ritorno dichiara gia' `Omit<Pane, "scrollOffset">`, quindi la
    // proprieta' non esiste in compilazione: qui si verifica che la STRIP
    // avvenga davvero a runtime — una spread che ricopiasse la pane intera
    // continuerebbe a soddisfare il tipo e a far viaggiare il campo.
    const wirePane: Record<string, unknown> = snapshot.panes["file:a"];
    expect(wirePane.scrollOffset).toBeUndefined();
    expect(snapshot.panes["file:a"].id).toBe("file:a");
  });
});

describe("Spazi: snapshot shape (both persist variants)", () => {
  const stateWithSpaces = (): PaneState => {
    const state = blankState();
    state.spaces = {
      "space:a": { id: "space:a", name: "Lavoro", order: 1, updatedAt: 10 },
    };
    state.activeSpaceId = "space:a";
    return state;
  };

  test("selectSyncableSnapshot INCLUDES spaces and EXCLUDES activeSpaceId", () => {
    const snapshot = selectSyncableSnapshot(stateWithSpaces());
    expect(snapshot.spaces).toEqual({
      "space:a": { id: "space:a", name: "Lavoro", order: 1, updatedAt: 10 },
    });
    // Device-local (focusedPaneId pattern): activeSpaceId never leaves the
    // device via the snapshot — it lives in its own localStorage key.
    expect((snapshot as Record<string, unknown>).activeSpaceId).toBeUndefined();
  });

  test("selectLocalSnapshot INCLUDES spaces and EXCLUDES activeSpaceId too", () => {
    const snapshot = selectLocalSnapshot(stateWithSpaces());
    expect(snapshot.spaces!["space:a"].name).toBe("Lavoro");
    expect((snapshot as Record<string, unknown>).activeSpaceId).toBeUndefined();
  });

  test("pane spaceId rides the outbound snapshot (membership syncs)", () => {
    const state = stateWithSpaces();
    state.panes["chat:t1"] = { id: "chat:t1", type: "chat", title: "A", spaceId: "space:a" };
    const snapshot = selectSyncableSnapshot(state);
    expect(snapshot.panes["chat:t1"].spaceId).toBe("space:a");
  });
});

describe("Spazi: filterVisiblePaneIds / selectVisiblePaneIds (the visiblePanels derivation)", () => {
  const spaces = {
    "space:a": { id: "space:a", name: "A", order: 0, updatedAt: 1 },
    "space:dead": { id: "space:dead", name: "D", order: 1, updatedAt: 1, deleted: true as const },
  };
  const panes: Record<string, Pane> = {
    "chat:default": { id: "chat:default", type: "chat" },
    "chat:a": { id: "chat:a", type: "chat", spaceId: "space:a" },
    "chat:dead": { id: "chat:dead", type: "chat", spaceId: "space:dead" },
    "chat:ghost": { id: "chat:ghost", type: "chat", spaceId: "space:ghost" },
  };
  const order = ["chat:default", "chat:a", "chat:dead", "chat:ghost", "chat:unregistered"];

  test("default space shows default + deleted-space + unknown-space + unregistered panes", () => {
    expect(filterVisiblePaneIds(order, panes, spaces, "space:default")).toEqual([
      "chat:default",
      "chat:dead",
      "chat:ghost",
      "chat:unregistered",
    ]);
  });

  test("a user space shows only its members, preserving order", () => {
    expect(filterVisiblePaneIds(order, panes, spaces, "space:a")).toEqual(["chat:a"]);
  });

  test("selectVisiblePaneIds reads group:default through the store's active space", () => {
    const state = blankState();
    state.spaces = spaces;
    state.panes = panes;
    state.groups["group:default"] = {
      id: "group:default",
      paneIds: order,
      splitRatio: 0.5,
      splitAxis: "horizontal",
    };
    state.activeSpaceId = "space:a";
    expect(selectVisiblePaneIds(state)).toEqual(["chat:a"]);
    state.activeSpaceId = "space:default";
    expect(selectVisiblePaneIds(state)).toEqual([
      "chat:default",
      "chat:dead",
      "chat:ghost",
      "chat:unregistered",
    ]);
  });
});

describe("filterVisiblePaneIds — stabilità sotto scroll (perf di App/PanelGrid)", () => {
  // Perché questo test esiste: `usePanelLifecycle` derivava `visiblePanels`
  // iscrivendosi a `s.panes`. Immer condivide le strutture, ma `panes` cambia
  // identità a ogni modifica di UNA QUALSIASI pane — e `setPaneScrollOffset`
  // ne scrive una ogni 250 ms mentre si scorre una chat. Ogni tick rompeva il
  // memo e ridisegnava App e `<PanelGrid>` (che non è memoizzato).
  //
  // La correzione si iscrive al RISULTATO con `useShallow`, e regge solo se
  // vale questa invariante: il risultato di `filterVisiblePaneIds` è
  // shallow-uguale prima e dopo una scrittura di scrollOffset. Se un giorno
  // la visibilità dovesse dipendere anche dallo scroll, questo test cade — ed
  // è giusto che cada, perché l'ottimizzazione non sarebbe più corretta.
  const pane = (id: string, extra: Partial<Pane> = {}): Pane =>
    ({ id, type: "chat", title: id, ...extra }) as Pane;

  test("scrivere scrollOffset non cambia l'insieme delle pane visibili", () => {
    const panes: Record<string, Pane> = {
      "chat:a": pane("chat:a"),
      "chat:b": pane("chat:b"),
      "chat:c": pane("chat:c", { spaceId: "space:altro" }),
    };
    // Lo spazio dev'essere VIVO nel registro, altrimenti resolvePaneSpace lo
    // ricade sul default e `chat:c` risulterebbe visibile.
    const spaces = spaceRegistry("space:altro", "Altro");
    const order = ["chat:a", "chat:b", "chat:c"];
    const before = filterVisiblePaneIds(order, panes, spaces, DEFAULT_SPACE_ID);

    // Il tick dello scroll: una nuova mappa `panes` (come fa Immer) con una
    // sola pane cambiata.
    const after = filterVisiblePaneIds(
      order,
      { ...panes, "chat:a": { ...panes["chat:a"], scrollOffset: 250 } },
      spaces,
      DEFAULT_SPACE_ID,
    );

    expect(before).toEqual(["chat:a", "chat:b"]);
    expect(after).toEqual(before);          // shallow-uguale → niente re-render
    expect(after).not.toBe(before);         // ...ma è un array NUOVO: per questo serve useShallow e non ===
  });

  test("un cambio VERO di visibilità invece si vede (il test sopra non è vacuo)", () => {
    const panes: Record<string, Pane> = { "chat:a": pane("chat:a"), "chat:b": pane("chat:b") };
    const order = ["chat:a", "chat:b"];
    const spaces = spaceRegistry("space:altrove", "Altrove");
    const before = filterVisiblePaneIds(order, panes, spaces, DEFAULT_SPACE_ID);
    const after = filterVisiblePaneIds(
      order,
      { ...panes, "chat:b": { ...panes["chat:b"], spaceId: "space:altrove" } },
      spaces,
      DEFAULT_SPACE_ID,
    );
    expect(before).toEqual(["chat:a", "chat:b"]);
    expect(after).toEqual(["chat:a"]);
  });
});

describe("resolveBootFocus / hasVisiblePane — su cosa si riapre l'app", () => {
  // «Appena apro Topics, dovrei aprire l'ultima tab che ho lasciato aperta. Se
  // no, di default dovrei trovarmi sulla sidebar» (Attilio, 07/08). Il fuoco
  // era già scritto in localStorage a ogni cambio; mancava il ripristino
  // ROBUSTO — `FOCUS_PANE` non controlla che la pane esista, quindi un id
  // salvato ma ormai morto riapriva l'app puntando a un fantasma. Sul telefono,
  // dove si vede una tab per volta, quel fantasma è una schermata vuota.
  const stateWith = (order: string[], activeSpaceId = DEFAULT_SPACE_ID): PaneState => {
    const state = blankState();
    for (const id of order) state.panes[id] = { id, type: "chat" };
    state.groups["group:default"] = { id: "group:default", paneIds: order, splitRatio: 0.5, splitAxis: "horizontal" };
    state.activeSpaceId = activeSpaceId;
    return state;
  };

  test("l'id salvato vince, se quella tab è ancora aperta", () => {
    expect(resolveBootFocus(stateWith(["a", "b", "c"]), "b")).toBe("b");
  });

  test("id morto → l'ULTIMA della fila, che è la più recente", () => {
    expect(resolveBootFocus(stateWith(["a", "b", "c"]), "sparita")).toBe("c");
  });

  test("nessun id salvato → sempre l'ultima", () => {
    expect(resolveBootFocus(stateWith(["a", "b"]), null)).toBe("b");
  });

  test("una tab APERTA MA IN UN ALTRO SPAZIO non vale: si ricade sulla fila visibile", () => {
    // Focalizzarla porterebbe la finestra su tutt'altro gruppo (il focus-follow
    // di usePanelLifecycle), cioè in un posto che l'utente non ha lasciato.
    const state = stateWith(["a", "b"], "space:altro");
    state.spaces = spaceRegistry("space:altro", "Altro");
    state.panes["altrove"] = { id: "altrove", type: "chat" };
    expect(resolveBootFocus(state, "altrove")).toBe(null);
  });

  test("nessuna tab → nessun fuoco, ed è il segnale con cui la sidebar parte aperta", () => {
    expect(resolveBootFocus(stateWith([]), "a")).toBe(null);
    expect(hasVisiblePane(stateWith([]))).toBe(false);
    expect(hasVisiblePane(stateWith(["a"]))).toBe(true);
  });
});
