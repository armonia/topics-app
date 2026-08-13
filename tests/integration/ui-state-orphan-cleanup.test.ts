/**
 * Integration test for `purgeOrphanTopicRefs` — the boot-time backstop
 * that prevented the May-3 sidebar-flash incident from recurring.
 *
 * Pins the contract:
 *   1. Clean DB → no-op (no rewrites, no server_seq burn).
 *   2. Orphan UUID in an array (`openChatTopicIds`) is dropped.
 *   3. Orphan UUID keying a `panes: { <uuid>: {…} }` map is dropped.
 *   4. Orphan UUID stored as `.id` of a value (e.g. ClosedPaneRecord) is dropped.
 *   5. Orphan UUID in a scalar pointer field (`activeChatTopicId`) is nulled.
 *   6. `server_seq` for every rewritten row jumps to MAX(server_seq)+N (monotonic).
 *   7. A second call on the now-clean DB is a no-op (idempotent).
 *   8. `archived = 1` topic with a project_path is NOT treated as an orphan
 *      (preserves the closedStack for unarchive flows).
 */

import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { join } from "node:path";

import { purgeOrphanTopicRefs } from "../../server/services/ui-state-orphan-cleanup";
import { testTmpDir } from "./helpers";

const TEST_DIR = testTmpDir("orphan-cleanup");
const DB_PATH = join(TEST_DIR, "db.sqlite");

function freshDb(): Database {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new Database(DB_PATH, { create: true });
  // Minimum schema needed: `topics` (with project_path + archived) +
  // `ui_state` (with payload_version + server_seq, mirroring migration 012).
  db.run(`
    CREATE TABLE topics (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      project_path TEXT,
      archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE ui_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      payload_version INTEGER NOT NULL DEFAULT 2,
      server_seq INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

const ORPHAN_A = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORPHAN_B = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KEEP_C = "33333333-cccc-4ccc-8ccc-cccccccccccc"; // archived → not orphan
const KEEP_D = "44444444-dddd-4ddd-8ddd-dddddddddddd"; // no project_path → not orphan

function seedTopics(db: Database) {
  // Two orphans (project_path set, not archived) — must be cleaned.
  db.run(`INSERT INTO topics (id, project_path, archived) VALUES (?, '/some/proj', 0)`, [ORPHAN_A]);
  db.run(`INSERT INTO topics (id, project_path, archived) VALUES (?, '/other/proj', 0)`, [ORPHAN_B]);
  // Archived project topic — must NOT be cleaned (closedStack must keep it).
  db.run(`INSERT INTO topics (id, project_path, archived) VALUES (?, '/proj', 1)`, [KEEP_C]);
  // Standalone topic (no project_path) — must NOT be cleaned.
  db.run(`INSERT INTO topics (id, project_path, archived) VALUES (?, NULL, 0)`, [KEEP_D]);
}

function putUiState(db: Database, key: string, value: unknown, seq = 0) {
  db.run(
    `INSERT OR REPLACE INTO ui_state (key, value, payload_version, server_seq, updated_at)
     VALUES (?, ?, 2, ?, datetime('now'))`,
    [key, JSON.stringify(value), seq],
  );
}

function getUiState(db: Database, key: string): { value: unknown; server_seq: number } {
  const row = db
    .query(`SELECT value, server_seq FROM ui_state WHERE key = ?`)
    .get(key) as { value: string; server_seq: number };
  return { value: JSON.parse(row.value), server_seq: row.server_seq };
}

describe("purgeOrphanTopicRefs", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
    seedTopics(db);
  });

  afterAll(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("1. clean DB → no rewrites, no server_seq burn", () => {
    putUiState(db, "openChatTopicIds", [KEEP_D], 5);
    putUiState(db, "pane-store-v2", { paneIds: [], panes: {} }, 7);

    const report = purgeOrphanTopicRefs(db);
    expect(report.rowsAffected).toBe(0);
    expect(report.refsRemoved).toBe(0);
    expect(getUiState(db, "openChatTopicIds").server_seq).toBe(5);
    expect(getUiState(db, "pane-store-v2").server_seq).toBe(7);
  });

  test("2. orphan in an array is dropped (openChatTopicIds)", () => {
    putUiState(db, "openChatTopicIds", [KEEP_D, ORPHAN_A, ORPHAN_B], 10);

    const report = purgeOrphanTopicRefs(db);
    expect(report.rowsAffected).toBe(1);
    expect(report.refsRemoved).toBe(2);
    expect(getUiState(db, "openChatTopicIds").value).toEqual([KEEP_D]);
  });

  test("3. orphan keying a panes map is dropped (pane-store-v2.panes)", () => {
    putUiState(
      db,
      "pane-store-v2",
      {
        paneIds: [KEEP_D, ORPHAN_A],
        panes: {
          [KEEP_D]: { id: KEEP_D, kind: "topic" },
          [ORPHAN_A]: { id: ORPHAN_A, kind: "topic" },
        },
      },
      20,
    );

    const report = purgeOrphanTopicRefs(db);
    expect(report.rowsAffected).toBe(1);
    // 1 from paneIds[] + 1 from panes object key
    expect(report.refsRemoved).toBe(2);
    const v = getUiState(db, "pane-store-v2").value as any;
    expect(v.paneIds).toEqual([KEEP_D]);
    expect(Object.keys(v.panes)).toEqual([KEEP_D]);
  });

  test("4. orphan in `.id` of a closedStack record is dropped", () => {
    putUiState(
      db,
      "pane-store-v2",
      {
        paneIds: [],
        panes: {},
        closedStack: [
          { id: ORPHAN_B, kind: "topic", closedAt: 100 },
          { id: KEEP_D, kind: "topic", closedAt: 200 },
        ],
      },
      30,
    );

    const report = purgeOrphanTopicRefs(db);
    expect(report.rowsAffected).toBe(1);
    expect(report.refsRemoved).toBe(1);
    const v = getUiState(db, "pane-store-v2").value as any;
    expect(v.closedStack.map((r: any) => r.id)).toEqual([KEEP_D]);
  });

  test("5. orphan in scalar pointer fields is nulled", () => {
    putUiState(
      db,
      "project-layout-test",
      {
        activeChatTopicId: ORPHAN_A,
        focusedTopicId: ORPHAN_A,
        focusedPaneId: KEEP_D,
        activeTopicId: KEEP_D,
      },
      40,
    );

    const report = purgeOrphanTopicRefs(db);
    expect(report.rowsAffected).toBe(1);
    expect(report.refsRemoved).toBe(2);
    const v = getUiState(db, "project-layout-test").value as any;
    expect(v.activeChatTopicId).toBeNull();
    expect(v.focusedTopicId).toBeNull();
    expect(v.focusedPaneId).toBe(KEEP_D);
    expect(v.activeTopicId).toBe(KEEP_D);
  });

  test("6. server_seq jumps to MAX(server_seq) + N monotonically across rewrites", () => {
    putUiState(db, "openChatTopicIds", [ORPHAN_A], 5);
    putUiState(db, "project-layout-1", { activeChatTopicId: ORPHAN_A }, 10);
    putUiState(db, "pane-store-v2", { panes: { [ORPHAN_B]: { id: ORPHAN_B } } }, 8);

    const report = purgeOrphanTopicRefs(db);
    expect(report.rowsAffected).toBe(3);

    const seqs = [
      getUiState(db, "openChatTopicIds").server_seq,
      getUiState(db, "project-layout-1").server_seq,
      getUiState(db, "pane-store-v2").server_seq,
    ];
    // All rewritten rows have server_seq strictly greater than the
    // pre-cleanup MAX (10). The three new sequences are unique and
    // contiguous starting from 11.
    seqs.forEach((s) => expect(s).toBeGreaterThan(10));
    const sorted = [...seqs].sort();
    expect(sorted).toEqual([11, 12, 13]);
  });

  test("7. second call on a clean DB is a no-op (idempotent)", () => {
    putUiState(db, "openChatTopicIds", [ORPHAN_A, KEEP_D], 1);

    const r1 = purgeOrphanTopicRefs(db);
    expect(r1.rowsAffected).toBe(1);
    const seqAfter1 = getUiState(db, "openChatTopicIds").server_seq;

    const r2 = purgeOrphanTopicRefs(db);
    expect(r2.rowsAffected).toBe(0);
    expect(r2.refsRemoved).toBe(0);
    // server_seq unchanged → confirms no-op did not write.
    expect(getUiState(db, "openChatTopicIds").server_seq).toBe(seqAfter1);
  });

  test("8. archived project-topic is NOT treated as orphan", () => {
    putUiState(db, "openChatTopicIds", [KEEP_C, ORPHAN_A], 1);

    const report = purgeOrphanTopicRefs(db);
    expect(report.rowsAffected).toBe(1);
    // KEEP_C survives (archived project topics belong on the closed stack).
    const v = getUiState(db, "openChatTopicIds").value as any[];
    expect(v).toContain(KEEP_C);
    expect(v).not.toContain(ORPHAN_A);
  });

  // Regression (resurrection bug): a project's OWN membership/geometry rows own
  // their project-bound topics — they are MEMBERS, not orphans. The sweep must
  // skip the `topics-project-panes-*` / `topics-project-layout-*` families
  // entirely. Before the fix, `stripOrphans` emptied `openChatTopicIds` (and
  // nulled `activeChatTopicId`) on every boot, then broadcast the wiped
  // membership — the "tab vanishes then reappears" symptom.
  test("9. project membership row (topics-project-panes-*) is left untouched", () => {
    const memKey = "topics-project-panes-abc123";
    putUiState(
      db,
      memKey,
      {
        nonChatPanes: [],
        openChatTopicIds: [ORPHAN_A, ORPHAN_B, KEEP_D],
        activeChatTopicId: ORPHAN_A,
      },
      50,
    );

    const report = purgeOrphanTopicRefs(db);

    // Not counted, not rewritten, server_seq preserved.
    expect(report.perKey.find((p) => p.key === memKey)).toBeUndefined();
    const { value, server_seq } = getUiState(db, memKey);
    expect(server_seq).toBe(50);
    const v = value as any;
    expect(v.openChatTopicIds).toEqual([ORPHAN_A, ORPHAN_B, KEEP_D]);
    expect(v.activeChatTopicId).toBe(ORPHAN_A);
  });

  test("10. project layout row (topics-project-layout-*) is left untouched", () => {
    const layoutKey = "topics-project-layout-abc123";
    putUiState(
      db,
      layoutKey,
      { activeChatTopicId: ORPHAN_A, focusedTopicId: ORPHAN_B },
      60,
    );

    const report = purgeOrphanTopicRefs(db);

    expect(report.perKey.find((p) => p.key === layoutKey)).toBeUndefined();
    const { value, server_seq } = getUiState(db, layoutKey);
    expect(server_seq).toBe(60);
    const v = value as any;
    expect(v.activeChatTopicId).toBe(ORPHAN_A);
    expect(v.focusedTopicId).toBe(ORPHAN_B);
  });

  test("11. standalone pane-store-v2 is STILL cleaned (regression guard for the fix)", () => {
    // The fix must not over-scope: a project-bound topic appearing as a
    // top-level pane in the standalone store is still a genuine orphan.
    putUiState(db, "pane-store-v2", { paneIds: [ORPHAN_A, KEEP_D], panes: {} }, 70);

    const report = purgeOrphanTopicRefs(db);
    expect(report.rowsAffected).toBe(1);
    expect(report.refsRemoved).toBe(1);
    expect((getUiState(db, "pane-store-v2").value as any).paneIds).toEqual([KEEP_D]);
  });
});
