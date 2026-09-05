/**
 * The one-off repair of a pane store written through a symlink: a real link in
 * a tmpdir, the per-project row renamed with it, and nothing to do the second
 * time.
 *
 * @covers PROJ-ID-04
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairCanonicalPaneState } from "./ui-state-canonical-repair";
import { projectPaneId } from "../lib/canonical-pane-state";
import { projectPanesKey } from "../../shared/project-keys";
import { loadAllUiState, PANE_STORE_KEY } from "../routes/ui-state";

let db: Database;
let base: string;
let realDir: string;
let link: string;

function putRow(key: string, value: unknown, seq: number): void {
  db.query("INSERT OR REPLACE INTO ui_state (key, value, payload_version, server_seq) VALUES (?, ?, 2, ?)")
    .run(key, JSON.stringify(value), seq);
}
function readRow(key: string): { value: any; server_seq: number } | null {
  const r = db.query("SELECT value, server_seq FROM ui_state WHERE key = ?").get(key) as { value: string; server_seq: number } | null;
  return r ? { value: JSON.parse(r.value), server_seq: r.server_seq } : null;
}
function snapshotWith(paneId: string, path: string) {
  return {
    panes: { [paneId]: { id: paneId, type: "project", title: "x", projectPath: path } },
    groups: { "group:default": { id: "group:default", paneIds: [paneId], splitRatio: 0.5, splitAxis: "horizontal" } },
    groupOrder: ["group:default"],
  };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "canon-repair-")));
  realDir = join(base, "real");
  mkdirSync(realDir);
  link = join(base, "link");
  symlinkSync(realDir, link);
  db = new Database(":memory:");
  db.run(`CREATE TABLE ui_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    payload_version INTEGER NOT NULL DEFAULT 1,
    server_seq INTEGER NOT NULL DEFAULT 0
  )`);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("repairCanonicalPaneState", () => {
  it("resolves the link in the pane store and renames the per-project row, in one go", () => {
    putRow(PANE_STORE_KEY, snapshotWith(projectPaneId(link), link), 3);
    putRow(projectPanesKey(link), { nonChatPanes: [], openChatTopicIds: ["t1"] }, 4);
    putRow("theme", "dark", 5);

    const report = repairCanonicalPaneState(db, undefined, 1000);
    expect(report.pairs).toEqual([{ raw: link, canon: realDir }]);
    expect(report.renamed).toEqual([{ from: projectPanesKey(link), to: projectPanesKey(realDir) }]);
    expect(report.dropped).toEqual([]);

    const store = readRow(PANE_STORE_KEY)!;
    expect(Object.keys(store.value.panes)).toEqual([projectPaneId(realDir)]);
    expect(store.value.panes[projectPaneId(realDir)].projectPath).toBe(realDir);
    expect(store.value.tombstones[projectPaneId(link)]).toEqual({ at: 1000, seq: 0 });
    // A rewrite is a write: a device that already saw seq 3 must accept it.
    expect(store.server_seq).toBe(6);
    expect(readRow(projectPanesKey(link))).toBeNull();
    expect(readRow(projectPanesKey(realDir))!.value.openChatTopicIds).toEqual(["t1"]);
  });

  it("keeps the canonical per-project row when it already exists and discards the raw one", () => {
    putRow(PANE_STORE_KEY, snapshotWith(projectPaneId(link), link), 1);
    putRow(projectPanesKey(link), { nonChatPanes: [], openChatTopicIds: ["raw"] }, 2);
    putRow(projectPanesKey(realDir), { nonChatPanes: [], openChatTopicIds: ["canon"] }, 3);

    const report = repairCanonicalPaneState(db);
    expect(report.dropped).toEqual([projectPanesKey(link)]);
    expect(report.renamed).toEqual([]);
    expect(readRow(projectPanesKey(link))).toBeNull();
    expect(readRow(projectPanesKey(realDir))!.value.openChatTopicIds).toEqual(["canon"]);
  });

  it("is idempotent: the second run touches nothing", () => {
    putRow(PANE_STORE_KEY, snapshotWith(projectPaneId(link), link), 1);
    putRow(projectPanesKey(link), { nonChatPanes: [], openChatTopicIds: [] }, 2);
    repairCanonicalPaneState(db);
    const before = db.query("SELECT key, value, server_seq FROM ui_state ORDER BY key").all();
    const second = repairCanonicalPaneState(db);
    expect(second).toEqual({ pairs: [], renamed: [], dropped: [] });
    expect(db.query("SELECT key, value, server_seq FROM ui_state ORDER BY key").all()).toEqual(before);
  });

  it("does nothing on an already canonical store or an empty table", () => {
    expect(repairCanonicalPaneState(db)).toEqual({ pairs: [], renamed: [], dropped: [] });
    putRow(PANE_STORE_KEY, snapshotWith(projectPaneId(realDir), realDir), 1);
    expect(repairCanonicalPaneState(db).pairs).toEqual([]);
    expect(readRow(PANE_STORE_KEY)!.server_seq).toBe(1);
  });
});

describe("the read path serves the same thing the repair writes", () => {
  it("ui-state:init carries the canonical pane and the per-project row under the canonical key, at the stored seq", () => {
    putRow(PANE_STORE_KEY, snapshotWith(projectPaneId(link), link), 3);
    putRow(projectPanesKey(link), { nonChatPanes: [], openChatTopicIds: ["t1"] }, 4);

    const { data, meta } = loadAllUiState(db);
    const store = data[PANE_STORE_KEY] as any;
    expect(Object.keys(store.panes)).toEqual([projectPaneId(realDir)]);
    expect(store.tombstones[projectPaneId(link)]).toMatchObject({ seq: 0 });
    expect(meta[PANE_STORE_KEY].server_seq).toBe(3);
    expect(data[projectPanesKey(link)]).toBeUndefined();
    expect((data[projectPanesKey(realDir)] as any).openChatTopicIds).toEqual(["t1"]);
    expect(meta[projectPanesKey(realDir)].server_seq).toBe(4);
    // The row itself is untouched: the read path does not write.
    expect(Object.keys(readRow(PANE_STORE_KEY)!.value.panes)).toEqual([projectPaneId(link)]);
  });
});
