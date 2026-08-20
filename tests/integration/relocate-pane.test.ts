/**
 * relocateIntoProject e i suoi due usi — il tab di terminale
 * (`moveTerminalPaneToProject`) e la chat (`moveTopicToProject`), entrambi in
 * server/lib/relocate-pane.ts.
 *
 * Regression for the live bug (2026-07-11): the splice removed the pane from
 * pane-store-v2 WITHOUT writing a tombstone. The client hydrate is a
 * union-with-tombstones (reducers/panes.ts HYDRATE_FROM_SNAPSHOT — the client
 * half is covered by multiClientResurrection.test.ts): any local-only pane the
 * snapshot doesn't tombstone is kept and re-persisted, so live clients put the
 * moved tab straight back — duplicated standalone+project, with closes coupled
 * (same session id on both surfaces).
 *
 * E per la chat (card 76b0058b): spostare un topic in un progetto scriveva solo
 * `projectPath`. La chat non entrava in `openChatTopicIds` e il suo pannello
 * browser restava nello store standalone — un tab orfano di una chat che da
 * quella superficie era sparita.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import { moveTerminalPaneToProject, moveTopicToProject } from "../../server/lib/relocate-pane";

const TEST_DATA = testTmpDir("relocate-data");
// Un progetto diverso per ogni test: l'appartenenza e' per-progetto e il DB
// e' condiviso dentro il file, quindi riusare la stessa cartella farebbe
// sommare i topic di un test nelle asserzioni dell'altro.
const TEST_PROJ_CHAT = testTmpDir("relocate-proj-chat");
const TEST_PROJ_SOLO = testTmpDir("relocate-proj-solo");

beforeAll(() => setupTestDataDir(TEST_DATA));

function readUi(db: any, key: string): any {
  const row = db.query("SELECT value, server_seq FROM ui_state WHERE key = ?").get(key) as
    | { value: string; server_seq: number }
    | undefined;
  return row ? { value: JSON.parse(row.value), seq: row.server_seq } : null;
}

function seedAppStore(db: any, panes: Record<string, any>): void {
  db.run(
    `INSERT INTO ui_state (key, value, payload_version, server_seq, updated_at)
     VALUES ('pane-store-v2', ?, 2, 10, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, server_seq = 10`,
    [JSON.stringify({
      panes,
      groups: { "group:default": { id: "group:default", paneIds: Object.keys(panes) } },
      groupOrder: ["group:default"],
      closedStack: [],
      lastSeq: 1,
    })],
  );
}

describe("moveTerminalPaneToProject", () => {
  test("splices the pane out, writes a TOMBSTONE, and adds it to the project membership", async () => {
    const ctx = await createTestAppContext();
    const db = ctx.db as any;
    const paneId = "terminal:T1";

    seedAppStore(db, { [paneId]: { id: paneId, type: "terminal", title: "My tab", scrollOffset: 42 } });

    const broadcasts: any[] = [];
    const { paneId: returned, membershipKey } = moveTerminalPaneToProject(
      db, (m) => broadcasts.push(m), { id: "T1", name: "My tab" }, TEST_DATA,
    );
    expect(returned).toBe(paneId);

    // App store: pane gone from panes + groups, tombstoned so the client
    // union-hydrate DROPS it instead of re-persisting it back.
    const app = readUi(db, "pane-store-v2")!;
    expect(app.value.panes[paneId]).toBeUndefined();
    expect(app.value.groups["group:default"].paneIds).toEqual([]);
    expect(typeof app.value.tombstones[paneId]).toBe("number");
    expect(app.seq).toBeGreaterThan(10);

    // Membership: carries the captured pane shape, scrollOffset stripped.
    const mem = readUi(db, membershipKey)!;
    expect(mem.value.nonChatPanes).toHaveLength(1);
    expect(mem.value.nonChatPanes[0].id).toBe(paneId);
    expect(mem.value.nonChatPanes[0].title).toBe("My tab");
    expect(mem.value.nonChatPanes[0].scrollOffset).toBeUndefined();

    // Both writes broadcast with their fresh seq.
    expect(broadcasts.map((b) => b.key).sort()).toEqual(["pane-store-v2", membershipKey].sort());

    // Idempotent: a second move must not duplicate the membership row.
    moveTerminalPaneToProject(db, () => {}, { id: "T1", name: "My tab" }, TEST_DATA);
    const mem2 = readUi(db, membershipKey)!;
    expect(mem2.value.nonChatPanes).toHaveLength(1);

    const { closeDatabase } = await import("../../server/db");
    closeDatabase();
  });
});

describe("moveTopicToProject", () => {
  test("porta dentro il progetto la chat E il suo browser, togliendoli dallo standalone", async () => {
    const ctx = await createTestAppContext();
    const db = ctx.db as any;
    const topicId = "11111111-2222-3333-4444-555555555555";
    const browserPaneId = `browser:${topicId}`;

    seedAppStore(db, {
      [topicId]: { id: topicId, type: "chat", topicId, title: "La chat" },
      [browserPaneId]: { id: browserPaneId, type: "browser", title: "Dashboard", url: "http://x/", scrollOffset: 7 },
      "terminal:altro": { id: "terminal:altro", type: "terminal", title: "Non mio" },
    });

    const broadcasts: any[] = [];
    const { membershipKey, movedPaneIds } = moveTopicToProject(
      db, (m) => broadcasts.push(m), { id: topicId, browserContextIds: [topicId] }, TEST_PROJ_CHAT,
    );
    expect(movedPaneIds).toEqual([browserPaneId]);

    const app = readUi(db, "pane-store-v2")!;
    // La chat e il browser escono dallo standalone, con tombstone; il tab di
    // un altro proprietario non si tocca.
    expect(app.value.panes[topicId]).toBeUndefined();
    expect(app.value.panes[browserPaneId]).toBeUndefined();
    expect(app.value.panes["terminal:altro"]).toBeDefined();
    expect(app.value.groups["group:default"].paneIds).toEqual(["terminal:altro"]);
    expect(typeof app.value.tombstones[topicId]).toBe("number");
    expect(typeof app.value.tombstones[browserPaneId]).toBe("number");

    const mem = readUi(db, membershipKey)!;
    expect(mem.value.openChatTopicIds).toEqual([topicId]);
    expect(mem.value.nonChatPanes).toHaveLength(1);
    expect(mem.value.nonChatPanes[0].id).toBe(browserPaneId);
    expect(mem.value.nonChatPanes[0].url).toBe("http://x/");
    expect(mem.value.nonChatPanes[0].scrollOffset).toBeUndefined();
    expect(broadcasts.map((b) => b.key).sort()).toEqual(["pane-store-v2", membershipKey].sort());

    // Idempotente: rifarlo non duplica ne' la chat ne' la pane.
    moveTopicToProject(db, () => {}, { id: topicId, browserContextIds: [topicId] }, TEST_PROJ_CHAT);
    const mem2 = readUi(db, membershipKey)!;
    expect(mem2.value.openChatTopicIds).toEqual([topicId]);
    expect(mem2.value.nonChatPanes).toHaveLength(1);

    const { closeDatabase } = await import("../../server/db");
    closeDatabase();
  });

  test("una chat senza browser aperto entra comunque nel progetto, e nessuna pane fantasma", async () => {
    const ctx = await createTestAppContext();
    const db = ctx.db as any;
    const topicId = "99999999-8888-7777-6666-555555555555";

    seedAppStore(db, { [`chat:${topicId}`]: { id: `chat:${topicId}`, type: "chat", topicId, title: "La chat" } });

    const { membershipKey, movedPaneIds } = moveTopicToProject(
      db, () => {}, { id: topicId, browserContextIds: [topicId] }, TEST_PROJ_SOLO,
    );
    expect(movedPaneIds).toEqual([]);

    const app = readUi(db, "pane-store-v2")!;
    // Anche la forma `chat:<id>` viene tolta: sbagliarne una lascia la chat
    // duplicata fuori dal progetto.
    expect(app.value.panes[`chat:${topicId}`]).toBeUndefined();
    expect(app.value.tombstones[`browser:${topicId}`]).toBeUndefined();

    const mem = readUi(db, membershipKey)!;
    expect(mem.value.openChatTopicIds).toEqual([topicId]);
    expect(mem.value.nonChatPanes).toEqual([]);

    const { closeDatabase } = await import("../../server/db");
    closeDatabase();
  });
});
