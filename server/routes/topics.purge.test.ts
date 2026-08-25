/**
 * @covers TOPIC-PURGE-01
 */
import { describe, expect, it } from "bun:test";
import { removeTopicFromUiStateValue, retractTopicTombstoneFromUiStateValue } from "./topics";

/**
 * Unit coverage for the archive/delete purge helper. The regression it guards:
 * a chat archived/deleted must be removed from EVERY ui_state record shape,
 * including the global `pane-store-v2` snapshot — which has no `openChatTopicIds`
 * field, so the old purge silently skipped it and left a phantom tab that
 * resurfaced on other devices ("ghost tab on mobile").
 */
describe("removeTopicFromUiStateValue", () => {
  const TID = "d16d99fa-e2ca-4a6a-a201-63a205dd9eda";

  it("removes a top-level chat pane from the pane-store-v2 snapshot", () => {
    const v = {
      panes: {
        [TID]: { id: TID, type: "chat", topicId: TID, title: "Master" },
        "project:%2Ffoo": { id: "project:%2Ffoo", type: "project" },
      },
      groups: {
        "group:default": { id: "group:default", paneIds: [TID, "project:%2Ffoo"] },
      },
      groupOrder: ["group:default"],
      closedStack: [],
    };
    const changed = removeTopicFromUiStateValue(v, TID);
    expect(changed).toBe(true);
    expect(v.panes[TID as keyof typeof v.panes]).toBeUndefined();
    expect(v.panes["project:%2Ffoo"]).toBeDefined();
    expect(v.groups["group:default"].paneIds).toEqual(["project:%2Ffoo"]);
  });

  it("removes a chat pane referenced by topicId even under a prefixed pane id", () => {
    const PID = `chat:${TID}`;
    const v = {
      panes: { [PID]: { id: PID, type: "chat", topicId: TID } },
      groups: { g1: { id: "g1", paneIds: [PID], activePaneId: PID } },
    };
    const changed = removeTopicFromUiStateValue(v, TID);
    expect(changed).toBe(true);
    expect(Object.keys(v.panes)).toHaveLength(0);
    expect(v.groups.g1.paneIds).toEqual([]);
    expect((v.groups.g1 as { activePaneId?: string }).activePaneId).toBeUndefined();
  });

  it("KEEPS the closedStack undo record, and tombstones its id instead", () => {
    // Cambiato il 2026-08-19, dopo che questa riga si e' rivelata la causa di
    // un difetto piu' grosso di quello che proteggeva.
    //
    // La catena: l'utente chiude la tab di una chat → il reducer crea il record
    // di undo → la cascata del ritiro archivia quel topic («tab-close») →
    // `archiveTopicFully` chiama questa purge → il record appena creato
    // spariva. E il tombstone non lo sostituiva, perche' guarda le pane tolte
    // da `panes`, e una pane gia' chiusa li' non c'e' piu': la chiusura non
    // lasciava NESSUNA traccia.
    //
    // Cancellarlo non serviva. Il difetto che questa purge protegge e' la TAB
    // FANTASMA — una chat archiviata che ricompare APERTA altrove — e quella
    // vive in `panes`, che continua a essere ripulito. `closedStack`, sul
    // client, alimenta `bumpClosed`: lo stesso segnale di CHIUSURA dei
    // tombstone. Non riapriva niente.
    const v: {
      panes: Record<string, unknown>;
      groups: Record<string, unknown>;
      closedStack: Array<{ id: string; pane: { id: string; type: string; topicId?: string } }>;
      tombstones?: Record<string, number>;
    } = {
      panes: {},
      groups: {},
      closedStack: [
        { id: "r1", pane: { id: TID, type: "chat", topicId: TID } },
        { id: "r2", pane: { id: "terminal:x", type: "terminal" } },
      ],
    };
    const changed = removeTopicFromUiStateValue(v, TID);
    // Entrambi i record restano: l'undo dell'utente e' lavoro suo.
    expect(v.closedStack.map((r) => r.id)).toEqual(["r1", "r2"]);
    // Ma l'id viene TIMBRATO, che e' cio' che tiene in piedi la protezione: un
    // pari che avesse ancora quella tab aperta la lascia cadere.
    expect(v.tombstones?.[TID]).toBeGreaterThan(0);
    expect(changed).toBe(true);
  });

  it("una chat archiviata DAL MENU sparisce comunque: la tab fantasma resta chiusa", () => {
    // L'altro caso, quello per cui la purge esiste. Qui non c'e' nessun record
    // di undo — la tab e' APERTA — e il comportamento non cambia di una virgola.
    const v: {
      panes: Record<string, unknown>;
      groups: Record<string, { id: string; paneIds: string[] }>;
      closedStack: unknown[];
      tombstones?: Record<string, number>;
    } = {
      panes: { [TID]: { id: TID, type: "chat", topicId: TID } },
      groups: { g: { id: "g", paneIds: [TID] } },
      closedStack: [],
    };
    expect(removeTopicFromUiStateValue(v, TID)).toBe(true);
    expect(Object.keys(v.panes)).toHaveLength(0);
    expect(v.groups.g.paneIds).toEqual([]);
    expect(v.tombstones?.[TID]).toBeGreaterThan(0);
  });

  it("removes the topic from the legacy/project openChatTopicIds shape", () => {
    const v = {
      nonChatPanes: [{ id: "terminal:x", type: "terminal" }],
      openChatTopicIds: ["other", TID],
      activeChatTopicId: TID,
    };
    const changed = removeTopicFromUiStateValue(v, TID);
    expect(changed).toBe(true);
    expect(v.openChatTopicIds).toEqual(["other"]);
    expect((v as { activeChatTopicId?: string }).activeChatTopicId).toBeUndefined();
    expect(v.nonChatPanes).toHaveLength(1); // non-chat panes untouched
  });

  it("leaves a durable tombstone for every pane it removed", () => {
    // Without this the purge is UNDONE by the client: HYDRATE_FROM_SNAPSHOT
    // unions local panes with the incoming snapshot and only drops the ones
    // carrying a close marker, so a bare deletion resurrects on the next PUT.
    const PID = `chat:${TID}`;
    const v: any = {
      panes: {
        [TID]: { id: TID, type: "chat", topicId: TID },
        [PID]: { id: PID, type: "chat", topicId: TID },
        "project:%2Ffoo": { id: "project:%2Ffoo", type: "project" },
      },
      groups: { "group:default": { id: "group:default", paneIds: [TID, PID, "project:%2Ffoo"] } },
      closedStack: [],
    };
    const before = Date.now();
    expect(removeTopicFromUiStateValue(v, TID)).toBe(true);
    expect(Object.keys(v.tombstones).sort()).toEqual([PID, TID].sort());
    expect(v.tombstones[TID]).toBeGreaterThanOrEqual(before);
    expect(v.tombstones["project:%2Ffoo"]).toBeUndefined(); // bystander untouched
  });

  it("merges into a pre-existing tombstone map and caps it at 500", () => {
    const v: any = {
      panes: { [TID]: { id: TID, type: "chat", topicId: TID } },
      groups: {},
      tombstones: Object.fromEntries(
        Array.from({ length: 500 }, (_, i) => [`old:${i}`, 1_000 + i]),
      ),
    };
    expect(removeTopicFromUiStateValue(v, TID)).toBe(true);
    const ids = Object.keys(v.tombstones);
    expect(ids).toHaveLength(500);
    expect(v.tombstones[TID]).toBeDefined();   // the fresh marker survives
    expect(v.tombstones["old:0"]).toBeUndefined(); // the oldest is evicted
    expect(v.tombstones["old:499"]).toBe(1_499);   // recent ones are kept
  });

  it("writes no tombstone when the record holds no pane for the topic", () => {
    // Shape-A-only records (project openChatTopicIds) have no `panes` map — a
    // tombstone there would be meaningless noise on the wire.
    const v: any = { openChatTopicIds: ["other", TID] };
    expect(removeTopicFromUiStateValue(v, TID)).toBe(true);
    expect(v.tombstones).toBeUndefined();
  });

  it("is a no-op (returns false) when the topic is absent", () => {
    const v = {
      panes: { "project:%2Ffoo": { id: "project:%2Ffoo", type: "project" } },
      groups: { "group:default": { id: "group:default", paneIds: ["project:%2Ffoo"] } },
      openChatTopicIds: ["someone-else"],
    };
    const snapshot = JSON.stringify(v);
    expect(removeTopicFromUiStateValue(v, TID)).toBe(false);
    expect(JSON.stringify(v)).toBe(snapshot); // unchanged
  });

  it("returns false for non-object / array inputs", () => {
    expect(removeTopicFromUiStateValue(null, TID)).toBe(false);
    expect(removeTopicFromUiStateValue("x", TID)).toBe(false);
    expect(removeTopicFromUiStateValue([1, 2], TID)).toBe(false);
  });
});

/**
 * The inverse half. Stamping a marker on archive without retracting it on
 * unarchive makes the reopen INVISIBLE: the client's hydrate runs a
 * bidirectional tombstone strip that deletes any pane whose id is tombstoned,
 * even when the incoming snapshot lists it — so the chat comes back in the
 * topic list but its tab is stripped on every load.
 */
describe("retractTopicTombstoneFromUiStateValue", () => {
  const TID = "d16d99fa-e2ca-4a6a-a201-63a205dd9eda";

  it("round-trips with the purge: archive stamps, unarchive retracts", () => {
    const v: any = {
      panes: { [TID]: { id: TID, type: "chat", topicId: TID } },
      groups: { "group:default": { id: "group:default", paneIds: [TID] } },
    };
    expect(removeTopicFromUiStateValue(v, TID)).toBe(true);
    expect(v.tombstones[TID]).toBeDefined();
    expect(retractTopicTombstoneFromUiStateValue(v, TID)).toBe(true);
    expect(v.tombstones[TID]).toBeUndefined();
  });

  it("retracts the prefixed pane-id encoding too, leaving bystanders alone", () => {
    const OTHER = "b0000000-0000-4000-8000-000000000000";
    const v: any = {
      tombstones: {
        [TID]: 111,
        [`chat:${TID}`]: 222,
        [OTHER]: 333,
        "terminal:xyz": 444,
      },
    };
    expect(retractTopicTombstoneFromUiStateValue(v, TID)).toBe(true);
    expect(Object.keys(v.tombstones).sort()).toEqual([OTHER, "terminal:xyz"].sort());
  });

  it("is a no-op (false) with no tombstone map or no matching id", () => {
    expect(retractTopicTombstoneFromUiStateValue({ panes: {} }, TID)).toBe(false);
    expect(retractTopicTombstoneFromUiStateValue({ tombstones: { other: 1 } }, TID)).toBe(false);
    expect(retractTopicTombstoneFromUiStateValue(null, TID)).toBe(false);
    expect(retractTopicTombstoneFromUiStateValue([1, 2], TID)).toBe(false);
  });
});
