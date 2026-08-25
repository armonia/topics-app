/**
 * sanitizeSidebarPayload — regression tests for the sidebar-state corruption.
 *
 * A pre-migration-012 client once PUT the whole GET envelope
 * ({ value, payload_version, server_seq }) back as the state, so the stored
 * value grew recursively-nested envelopes and every later client re-persisted
 * the junk verbatim (the spread over DEFAULT_STATE does NOT drop extra keys
 * at runtime). The web sidebar then read pinnedItems from the wrong nesting
 * level → "Fissati" empty on web while desktop showed its localStorage copy.
  * @covers LAYOUT-20
 */

import { describe, expect, test } from "bun:test";
import {
  SIDEBAR_VIEW_MODES,
  hydrateSidebarState,
  mergeSidebarStates,
  nextSidebarViewMode,
  readServerSeq,
  sanitizeSidebarPayload,
  type SidebarViewMode,
} from "./useSidebarState";

const REAL_STATE = {
  expandedNodes: ["project:/x"],
  viewMode: "timeline" as const,
  showArchived: false,
  pinnedItems: ["topic-1", "project:/y"],
  showProjects: true,
  showChats: true,
  showTerminals: true,
  showProjectsArchived: false,
  showChatsArchived: true,
  browserExpanded: false,
};

describe("sanitizeSidebarPayload", () => {
  test("plain state passes through with only known keys", () => {
    const out = sanitizeSidebarPayload({ ...REAL_STATE, junk: 1, payload_version: 2 });
    expect(out).toEqual(REAL_STATE);
    expect(out && ("junk" in out)).toBe(false);
  });

  test("unwraps a single GET envelope", () => {
    const out = sanitizeSidebarPayload({ value: REAL_STATE, payload_version: 2, server_seq: 42 });
    expect(out?.pinnedItems).toEqual(["topic-1", "project:/y"]);
    expect(out && ("server_seq" in out)).toBe(false);
  });

  test("heals the historical recursively-nested corruption (envelope in envelope)", () => {
    // Shape observed in production 2026-07-12: v2 envelope wrapping a stored
    // value that is itself a v2 envelope wrapping a v1 envelope wrapping the
    // real state.
    const corrupted = {
      value: {
        expandedNodes: [],
        pinnedItems: [],
        payload_version: 2,
        server_seq: 993,
        value: {
          payload_version: 1,
          server_seq: 0,
          value: REAL_STATE,
        },
      },
      payload_version: 2,
      server_seq: 1357664,
    };
    const out = sanitizeSidebarPayload(corrupted);
    expect(out?.pinnedItems).toEqual(["topic-1", "project:/y"]);
    expect(out?.expandedNodes).toEqual(["project:/x"]);
    expect(out && ("value" in out)).toBe(false);
  });

  test("intermediate envelope levels do NOT shadow the innermost real state", () => {
    // The corrupted middle level carries stale pinnedItems: [] — the healer
    // must descend past it, not merge it.
    const corrupted = {
      value: { pinnedItems: [], payload_version: 2, server_seq: 1, value: { pinnedItems: ["a"] } },
      payload_version: 2,
      server_seq: 2,
    };
    expect(sanitizeSidebarPayload(corrupted)?.pinnedItems).toEqual(["a"]);
  });

  test("non-object cores return null", () => {
    expect(sanitizeSidebarPayload(null)).toBeNull();
    expect(sanitizeSidebarPayload("nope")).toBeNull();
    expect(sanitizeSidebarPayload({ value: null, server_seq: 3 })).toBeNull();
  });

  test("a state that legitimately lacks envelope keys is untouched", () => {
    const partial = { pinnedItems: ["only-pins"] };
    expect(sanitizeSidebarPayload(partial)).toEqual({ pinnedItems: ["only-pins"] });
  });
});

/**
 * Il ciclo delle viste della sidebar.
 *
 * Era un ternario a due (`timeline ? grouped : timeline`) dentro il toggle, con
 * una SECONDA lista di casi nel bottone che decideva icona ed etichetta. Con
 * l'arrivo della terza vista ('state') due liste scritte a mano sarebbero
 * divergute al primo che se ne aggiunge una quarta: ora la funzione è una e la
 * usano entrambi.
 */
describe("nextSidebarViewMode", () => {
  test("cicla nell'ordine dichiarato e torna all'inizio", () => {
    expect(nextSidebarViewMode("timeline")).toBe("state");
    expect(nextSidebarViewMode("state")).toBe("timeline");
  });

  test("il modo per TIPO non esiste piu': un valore salvato ricade sulla lista", () => {
    // Rimosso il 06/08. Uno stato salvato prima non deve lasciare la sidebar
    // vuota: `hydrateSidebarState` lo riporta a 'timeline'.
    expect(hydrateSidebarState({ viewMode: "grouped" as SidebarViewMode }).viewMode).toBe("timeline");
    // E il ciclo non ci passa piu'.
    expect(SIDEBAR_VIEW_MODES).not.toContain("grouped" as SidebarViewMode);
  });

  test("un giro completo torna al punto di partenza, da qualunque modo", () => {
    for (const start of SIDEBAR_VIEW_MODES) {
      let m: SidebarViewMode = start;
      for (let i = 0; i < SIDEBAR_VIEW_MODES.length; i++) m = nextSidebarViewMode(m);
      expect(m).toBe(start);
    }
  });

  test("un valore non riconosciuto riparte da 'timeline' invece di bloccarsi", () => {
    // Lo storage è schemaless: un client vecchio (o corrotto) può aver persistito
    // qualunque stringa. Senza questa guardia `indexOf` darebbe -1 e il bottone
    // non muoverebbe più la vista, senza alcun errore.
    expect(nextSidebarViewMode("zzz" as SidebarViewMode)).toBe("timeline");
  });

  test("ogni modo dichiarato è raggiungibile dal ciclo", () => {
    const visti = new Set<SidebarViewMode>();
    let m: SidebarViewMode = SIDEBAR_VIEW_MODES[0];
    for (let i = 0; i < SIDEBAR_VIEW_MODES.length; i++) { visti.add(m); m = nextSidebarViewMode(m); }
    expect([...visti].sort()).toEqual([...SIDEBAR_VIEW_MODES].sort());
  });
});

// ── hydrateSidebarState: default, migrazioni, riconciliazione ────────────────

describe("hydrateSidebarState", () => {
  test("un payload senza layout non rompe: la disposizione esce dall'ordine di pin", () => {
    const s = hydrateSidebarState({ pinnedItems: ["a", "b", "c"] });
    expect(s.pinnedLayout.flatMap(r => r.keys)).toEqual(["a", "b", "c"]);
    for (const row of s.pinnedLayout) {
      expect(row.widths.length).toBe(row.keys.length);
    }
  });

  test("la chiave di progetto codificata diventa grezza", () => {
    const s = hydrateSidebarState({ pinnedItems: ["project:%2Fwork%2Fx"] });
    expect(s.pinnedItems).toEqual(["project:/work/x"]);
  });

  test("lo stesso progetto salvato in entrambe le forme resta UNO", () => {
    // È lo stato che si trova sul campo: fissato una volta dalla sidebar
    // (grezzo) e una dalla tab (codificato), prima che le due forme fossero
    // unificate.
    const s = hydrateSidebarState({
      pinnedItems: ["project:/work/x", "topic-1", "project:%2Fwork%2Fx"],
    });
    expect(s.pinnedItems).toEqual(["project:/work/x", "topic-1"]);
    expect(s.pinnedLayout.flatMap(r => r.keys)).toEqual(["project:/work/x", "topic-1"]);
  });

  test("il layout perde le celle dei fissati spariti e accoglie quelli nuovi", () => {
    const s = hydrateSidebarState({
      pinnedItems: ["a", "nuovo"],
      pinnedLayout: [{ keys: ["a", "sparito"], widths: [0.5, 0.5] }],
    });
    expect(s.pinnedLayout.flatMap(r => r.keys).sort()).toEqual(["a", "nuovo"]);
  });

  test("è idempotente", () => {
    const once = hydrateSidebarState({ pinnedItems: ["a", "b"], pinnedLayout: [] });
    const twice = hydrateSidebarState(once);
    expect(twice.pinnedItems).toEqual(once.pinnedItems);
    expect(twice.pinnedLayout).toEqual(once.pinnedLayout);
  });

  test("regge pinnedItems non-array o sporco senza esplodere", () => {
    expect(hydrateSidebarState({ pinnedItems: 42 as never }).pinnedItems).toEqual([]);
    expect(hydrateSidebarState({ pinnedItems: ["a", 7 as never, "b"] }).pinnedItems).toEqual(["a", "b"]);
  });

  test("il campo layout sopravvive al giro di sanitize (è in DEFAULT_STATE)", () => {
    // Se `pinnedLayout` non fosse fra le chiavi note, il sanitize lo scarterebbe
    // in silenzio a ogni GET/WS/cross-tab: scritto e mai riletto.
    const payload = { pinnedItems: ["a"], pinnedLayout: [{ keys: ["a"], widths: [1] }] };
    const sv = sanitizeSidebarPayload(payload);
    expect(sv?.pinnedLayout).toBeDefined();
    expect(hydrateSidebarState(sv!).pinnedLayout[0].keys).toEqual(["a"]);
  });
});

// ── mergeSidebarStates: cosa succede quando il server rifiuta la scrittura ───

describe("mergeSidebarStates", () => {
  const base = (over: Partial<ReturnType<typeof hydrateSidebarState>>) =>
    hydrateSidebarState({ ...over });

  test("i pin dei due lati si sommano, nessuno viene perso", () => {
    const remote = base({ pinnedItems: ["a", "remoto"] });
    const local = base({ pinnedItems: ["a", "locale"] });
    const m = mergeSidebarStates(remote, local);
    expect(m.pinnedItems.sort()).toEqual(["a", "locale", "remoto"]);
  });

  test("ogni pin arrivato da fuori riceve comunque una cella", () => {
    const remote = base({ pinnedItems: ["a", "remoto"] });
    const local = base({ pinnedItems: ["a"] });
    const m = mergeSidebarStates(remote, local);
    expect(m.pinnedLayout.flatMap(r => r.keys).sort()).toEqual(["a", "remoto"]);
  });

  test("la disposizione locale comanda: chi ha appena trascinato è qui", () => {
    const remote = base({ pinnedItems: ["a", "b"], pinnedLayout: [{ keys: ["a", "b"], widths: [0.5, 0.5] }] });
    const local = base({ pinnedItems: ["a", "b"], pinnedLayout: [{ keys: ["b"], widths: [1] }, { keys: ["a"], widths: [1] }] });
    const m = mergeSidebarStates(remote, local);
    expect(m.pinnedLayout.map(r => r.keys)).toEqual([["b"], ["a"]]);
  });

  test("i nodi espansi si sommano", () => {
    const m = mergeSidebarStates(base({ expandedNodes: ["x"] }), base({ expandedNodes: ["y"] }));
    expect(m.expandedNodes.sort()).toEqual(["x", "y"]);
  });

  test("le intenzioni di questo schermo restano locali", () => {
    const remote = base({ viewMode: "timeline", showArchived: true });
    const local = base({ viewMode: "state", showArchived: false });
    const m = mergeSidebarStates(remote, local);
    expect(m.viewMode).toBe("state");
    expect(m.showArchived).toBe(false);
  });
});

describe("readServerSeq", () => {
  test("legge la versione dalla busta", () => {
    expect(readServerSeq({ value: {}, server_seq: 7 })).toBe(7);
  });

  test("null quando non c'è o non è un numero", () => {
    expect(readServerSeq(null)).toBeNull();
    expect(readServerSeq({ value: {} })).toBeNull();
    expect(readServerSeq({ server_seq: "7" })).toBeNull();
    expect(readServerSeq({ server_seq: Number.NaN })).toBeNull();
  });
});
