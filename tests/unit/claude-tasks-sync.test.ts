/**
 * @covers TASKSYNC-01
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalize,
  claudeWins,
  ingestFile,
  startClaudeTasksSync,
  type SyncTarget,
  type TopicsTaskRow,
  type TopicsTaskUpsert,
} from "../../server/services/claude-tasks-sync";

class FakeTarget implements SyncTarget {
  rows = new Map<string, TopicsTaskRow>();
  findByClaudeTaskId(id: string): TopicsTaskRow | null {
    return this.rows.get(id) ?? null;
  }
  upsertFromClaude(input: TopicsTaskUpsert): void {
    this.rows.set(input.claude_task_id, {
      id: "topics-" + input.claude_task_id,
      claude_task_id: input.claude_task_id,
      text: input.text,
      description: input.description,
      status: input.status,
      priority: input.priority,
      updated_at: input.updated_at,
    });
  }
}

describe("claude-tasks-sync · normalize", () => {
  it("rejects items without an id", () => {
    expect(normalize({} as any)).toBeNull();
  });

  it("maps status synonyms", () => {
    expect(normalize({ id: "1", status: "Pending" })!.status).toBe("todo");
    expect(normalize({ id: "1", status: "Completed" })!.status).toBe("done");
    expect(normalize({ id: "1", status: "in-progress" })!.status).toBe("in_progress");
  });

  it("clamps priority strings to numeric scale", () => {
    expect(normalize({ id: "1", priority: "P0" })!.priority).toBe(0);
    expect(normalize({ id: "1", priority: "high" })!.priority).toBe(1);
    expect(normalize({ id: "1", priority: "low" })!.priority).toBe(3);
    expect(normalize({ id: "1", priority: "garbage" })!.priority).toBe(2);
  });

  it("defaults priority to 2 when missing", () => {
    expect(normalize({ id: "1" })!.priority).toBe(2);
  });

  it("preserves provided updated_at in ISO 8601", () => {
    const out = normalize({ id: "1", updated_at: "2026-05-17T10:00:00Z" });
    expect(out!.updated_at).toBe("2026-05-17T10:00:00.000Z");
  });
});

describe("claude-tasks-sync · claudeWins (KANBAN-DELTA-02 conflict resolution)", () => {
  it("returns true when no local row exists", () => {
    expect(claudeWins(null, { ...base(), updated_at: "2026-05-17T00:00:00Z" })).toBe(true);
  });

  it("returns true when claude side is newer", () => {
    expect(
      claudeWins(
        { ...baseRow(), updated_at: "2026-05-16T00:00:00Z" },
        { ...base(), updated_at: "2026-05-17T00:00:00Z" },
      ),
    ).toBe(true);
  });

  it("returns false when local side is strictly newer", () => {
    expect(
      claudeWins(
        { ...baseRow(), updated_at: "2026-05-18T00:00:00Z" },
        { ...base(), updated_at: "2026-05-17T00:00:00Z" },
      ),
    ).toBe(false);
  });

  it("returns true on tie (claude wins on equal timestamps — favours upstream)", () => {
    expect(
      claudeWins(
        { ...baseRow(), updated_at: "2026-05-17T00:00:00Z" },
        { ...base(), updated_at: "2026-05-17T00:00:00Z" },
      ),
    ).toBe(true);
  });
});

describe("claude-tasks-sync · ingestFile", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claude-tasks-"));
    file = join(dir, "tasks.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("upserts every task in an array payload", () => {
    writeFileSync(file, JSON.stringify([
      { id: "T1", title: "Do A", status: "todo" },
      { id: "T2", title: "Do B", status: "in_progress" },
    ]));
    const target = new FakeTarget();
    const res = ingestFile(file, target);
    expect(res.upserted).toBe(2);
    expect(target.rows.size).toBe(2);
    expect(target.rows.get("T1")!.status).toBe("todo");
    expect(target.rows.get("T2")!.status).toBe("in_progress");
  });

  it("supports payload with top-level tasks array", () => {
    writeFileSync(file, JSON.stringify({ tasks: [{ id: "T9", title: "X" }] }));
    const target = new FakeTarget();
    const res = ingestFile(file, target);
    expect(res.upserted).toBe(1);
    expect(target.rows.get("T9")!.text).toBe("X");
  });

  it("tolerates malformed JSON", () => {
    writeFileSync(file, "{not json");
    const target = new FakeTarget();
    const res = ingestFile(file, target);
    expect(res.upserted).toBe(0);
    expect(target.rows.size).toBe(0);
  });

  it("skips entries that lose the conflict resolution", () => {
    const target = new FakeTarget();
    target.rows.set("T1", {
      id: "topics-T1", claude_task_id: "T1", text: "local",
      description: null, status: "review", priority: 1,
      updated_at: "2027-01-01T00:00:00.000Z",
    });
    writeFileSync(file, JSON.stringify([
      { id: "T1", title: "from claude", updated_at: "2026-01-01T00:00:00Z" },
    ]));
    const res = ingestFile(file, target);
    expect(res.upserted).toBe(0);
    expect(res.skipped).toBe(1);
    expect(target.rows.get("T1")!.text).toBe("local");
  });
});

describe("claude-tasks-sync · startClaudeTasksSync", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claude-projects-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function makeProject(slug: string, tasks: any[]) {
    const tasksDir = join(root, slug, "tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "shared.json"), JSON.stringify(tasks));
    return tasksDir;
  }

  it("ingests multiple projects on first scan", () => {
    makeProject("proj-A", [{ id: "A1", title: "alpha" }]);
    makeProject("proj-B", [{ id: "B1", title: "beta" }]);
    const target = new FakeTarget();
    const handle = startClaudeTasksSync({ claudeProjectsDir: root, target, pollMs: 60_000 });
    const res = handle.scanNow();
    handle.stop();
    // scanNow returns delta since previous, which on the initial-scan-then-scanNow path
    // will be 0 if both files unchanged. Force a fresh handle for clean assertion.
    const t2 = new FakeTarget();
    const h2 = startClaudeTasksSync({ claudeProjectsDir: root, target: t2, pollMs: 60_000 });
    h2.stop();
    expect(t2.rows.size).toBe(2);
    expect(t2.rows.has("A1")).toBe(true);
    expect(t2.rows.has("B1")).toBe(true);
    expect(res).toBeDefined();
  });

  it("re-ingests on file modification", async () => {
    const taskDir = makeProject("proj-C", [{ id: "C1", title: "v1", updated_at: "2026-01-01T00:00:00Z" }]);
    const target = new FakeTarget();
    const handle = startClaudeTasksSync({ claudeProjectsDir: root, target, pollMs: 50 });
    // Allow initial scan to complete.
    await new Promise((r) => setTimeout(r, 50));
    expect(target.rows.get("C1")!.text).toBe("v1");

    // Sleep a tick so mtime advances.
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(
      join(taskDir, "shared.json"),
      JSON.stringify([{ id: "C1", title: "v2", updated_at: "2026-05-17T00:00:00Z" }]),
    );
    await new Promise((r) => setTimeout(r, 200));
    handle.stop();
    expect(target.rows.get("C1")!.text).toBe("v2");
  });

  it("gracefully handles missing root", () => {
    const target = new FakeTarget();
    const handle = startClaudeTasksSync({
      claudeProjectsDir: join(root, "non-existent"),
      target,
      pollMs: 60_000,
    });
    const res = handle.scanNow();
    handle.stop();
    expect(res.files).toBe(0);
    expect(target.rows.size).toBe(0);
  });
});

function base(): TopicsTaskUpsert {
  return {
    claude_task_id: "X",
    text: "x",
    description: null,
    status: "todo",
    priority: 2,
    updated_at: "2026-05-17T00:00:00.000Z",
  };
}

function baseRow(): TopicsTaskRow {
  return {
    id: "topics-X",
    claude_task_id: "X",
    text: "x",
    description: null,
    status: "todo",
    priority: 2,
    updated_at: "2026-05-17T00:00:00.000Z",
  };
}
