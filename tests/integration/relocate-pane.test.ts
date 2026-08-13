/**
 * moveTerminalPaneToProject — the MCP move_session_to_project / open_project /
 * create_project terminal-tab relocation core (server/lib/relocate-pane.ts).
 *
 * Regression for the live bug (2026-07-11): the splice removed the pane from
 * pane-store-v2 WITHOUT writing a tombstone. The client hydrate is a
 * union-with-tombstones (reducers/panes.ts HYDRATE_FROM_SNAPSHOT — the client
 * half is covered by multiClientResurrection.test.ts): any local-only pane the
 * snapshot doesn't tombstone is kept and re-persisted, so live clients put the
 * moved tab straight back — duplicated standalone+project, with closes coupled
 * (same session id on both surfaces).
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir, cleanupTestDataDir } from "./helpers";
import { moveTerminalPaneToProject } from "../../server/lib/relocate-pane";

const TEST_DATA = testTmpDir("relocate-data");

beforeAll(() => setupTestDataDir(TEST_DATA));
afterAll(() => cleanupTestDataDir(TEST_DATA));

function readUi(db: any, key: string): any {
  const row = db.query("SELECT value, server_seq FROM ui_state WHERE key = ?").get(key) as
    | { value: string; server_seq: number }
    | undefined;
  return row ? { value: JSON.parse(row.value), seq: row.server_seq } : null;
}

describe("moveTerminalPaneToProject", () => {
  test("splices the pane out, writes a TOMBSTONE, and adds it to the project membership", async () => {
    const ctx = await createTestAppContext();
    const db = ctx.db as any;
    const paneId = "terminal:T1";

    db.run(
      `INSERT INTO ui_state (key, value, payload_version, server_seq, updated_at)
       VALUES ('pane-store-v2', ?, 2, 10, datetime('now'))`,
      [JSON.stringify({
        panes: { [paneId]: { id: paneId, type: "terminal", title: "My tab", scrollOffset: 42 } },
        groups: { "group:default": { id: "group:default", paneIds: [paneId] } },
        groupOrder: ["group:default"],
        closedStack: [],
        lastSeq: 1,
      })],
    );

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
