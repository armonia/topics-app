/**
 * The project's share of the weekly quota: two projects in the same hour, no
 * history, a worktree folding onto its project, a transcript outside every
 * project.
 * @covers USAGE-28
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { collectProjectCalls, projectPointsInWindow, projectQuota } from "./project-quota";
import type { TokenUsage } from "./person-usage";
import { createUsageRouter } from "../routes/usage";

const PROJECT_MIGRATION = await Bun.file(new URL("../db/migrations/20261118100000-usage-project-path.sql", import.meta.url)).text();

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL)`);
  db.run(`CREATE TABLE worktrees (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, abs_path TEXT NOT NULL)`);
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY, session_key TEXT NOT NULL, provider TEXT, project_path TEXT)`);
  db.run(`CREATE TABLE messages (id TEXT PRIMARY KEY, session_key TEXT NOT NULL, role TEXT NOT NULL, timestamp TEXT NOT NULL,
    usage_prompt_tokens INTEGER, usage_completion_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER)`);
  db.run(`CREATE TABLE subagents (id TEXT PRIMARY KEY, parent_session_key TEXT NOT NULL, session_key TEXT, claude_session_id TEXT, cwd TEXT NOT NULL,
    runtime TEXT NOT NULL DEFAULT 'claude-code', created_at TEXT NOT NULL)`);
  db.run(`CREATE TABLE usage_records (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), timestamp INTEGER NOT NULL, session_key TEXT NOT NULL,
    topic_id TEXT, model TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, purpose TEXT, provider TEXT,
    cache_read_tokens INTEGER, cache_creation_tokens INTEGER, measured INTEGER NOT NULL DEFAULT 1)`);
  db.exec(PROJECT_MIGRATION);
  return db;
}

const HOUR_START = Date.parse("2026-11-17T15:00:00.000Z");
const T0 = HOUR_START + 5 * 60_000;

function insMsg(db: Database, sk: string, ts: number, p: number, o: number) {
  db.run(`INSERT INTO messages (id, session_key, role, timestamp, usage_prompt_tokens, usage_completion_tokens, cache_read_tokens, cache_creation_tokens)
    VALUES (lower(hex(randomblob(16))), ?, 'assistant', ?, ?, ?, 0, 0)`, [sk, new Date(ts).toISOString(), p, o]);
}

function fakeTranscript(calls: Array<{ ts: number; usage: TokenUsage }>) {
  const byKey = new Map<string, Array<{ ts: number; usage: TokenUsage }>>();
  return {
    reader: (cwd: string, sid: string) => byKey.get(`${cwd}\u0000${sid}`) ?? [],
    register(cwd: string, sid: string) { byKey.set(`${cwd}\u0000${sid}`, calls); },
  };
}

describe("two projects in the same hour (USAGE-28 scenario)", () => {
  test("A gets 7.5 points, B 2.5, a worktree counts for its project", async () => {
    const db = makeDb();
    // Project A: native chat (weight 200) + native subagent (weight 100) = 300.
    db.run(`INSERT INTO topics (id, session_key, provider, project_path) VALUES ('tA', 'skA', 'topics', '/proj/A')`);
    insMsg(db, "skA", T0, 200, 0);
    db.run(`INSERT INTO subagents (id, parent_session_key, session_key, cwd, runtime, created_at) VALUES ('subA', 'skA', 'skA-sub', '/proj/A', 'topics', ?)`, [new Date(T0).toISOString()]);
    insMsg(db, "skA-sub", T0, 100, 0);

    // Project B: a Claude Code transcript (weight 100) in a WORKTREE of B.
    db.run(`INSERT INTO projects (id, path) VALUES ('pB', '/proj/B')`);
    db.run(`INSERT INTO worktrees (id, project_id, abs_path) VALUES ('wB', 'pB', '/worktrees/B-feature')`);
    const t = fakeTranscript([{ ts: T0, usage: { input: 100, output: 0, cacheWrite: 0, cacheRead: 0 } }]);
    t.register("/worktrees/B-feature", "csidB");
    db.run(`INSERT INTO subagents (id, parent_session_key, claude_session_id, cwd, runtime, created_at) VALUES ('subB', 'skB', 'csidB', '/worktrees/B-feature', 'claude-code', ?)`, [new Date(T0).toISOString()]);

    const history = [
      { t: Math.floor(HOUR_START / 1000) - 60, s: { "claude|acc1|7d": 0 } },
      { t: Math.floor(T0 / 1000), s: { "claude|acc1|7d": 10 } },
    ];
    const historyFile = `/tmp/project-quota-test-${Date.now()}.jsonl`;
    await Bun.write(historyFile, history.map((l) => JSON.stringify(l)).join("\n"));

    const result = projectQuota(db, { now: T0 + 60_000, historyFile, readTranscript: t.reader, listOutsideTranscripts: () => [] });
    expect(result.quotaHistory).toBe(true);
    const a = result.projects.find((p) => p.projectPath === "/proj/A");
    const b = result.projects.find((p) => p.projectId && p.projectPath !== "/proj/A");
    expect(a?.points7d).toBe(7.5);
    expect(b?.points7d).toBe(2.5);
    // The worktree's project id is the one computed from the PROJECT's path, not the worktree's own path.
    expect(b?.projectPath).toBe("/proj/B");
  });
});

describe("no quota history", () => {
  test("quotaHistory is false and points are null, only weighted tokens", () => {
    const db = makeDb();
    db.run(`INSERT INTO topics (id, session_key, provider, project_path) VALUES ('tA', 'skA', 'topics', '/proj/A')`);
    insMsg(db, "skA", T0, 200, 0);
    const result = projectQuota(db, { now: T0 + 60_000, historyFile: `/tmp/project-quota-test-missing-${Date.now()}.jsonl`, listOutsideTranscripts: () => [] });
    expect(result.quotaHistory).toBe(false);
    const a = result.projects.find((p) => p.projectPath === "/proj/A")!;
    expect(a.points7d).toBeNull();
    expect(a.weighted7d).toBe(200);
  });
});

describe("a Claude Code transcript outside every project", () => {
  test("lands in the outside-projects bucket (projectId null), not on a random project", async () => {
    const db = makeDb();
    const file = `/tmp/project-quota-outside-${Date.now()}.jsonl`;
    const line = JSON.stringify({ type: "assistant", uuid: "u1", timestamp: new Date(T0).toISOString(), cwd: "/home/someone/scratch",
      message: { id: "m1", usage: { input_tokens: 50, output_tokens: 0 } } });
    await Bun.write(file, line);
    const result = projectQuota(db, {
      now: T0 + 60_000,
      historyFile: `/tmp/project-quota-test-missing-${Date.now()}.jsonl`,
      listOutsideTranscripts: () => [{ path: file, mtimeMs: T0 }],
    });
    const outside = result.projects.find((p) => p.projectId === null);
    expect(outside).toBeDefined();
    expect(outside?.weighted7d).toBe(50);
  });
});

describe("GET /api/usage/projects/quota", () => {
  test("answers the same result projectQuota would compute, with cachedAt", async () => {
    const db = makeDb();
    db.run(`INSERT INTO topics (id, session_key, provider, project_path) VALUES ('tA', 'skA', 'topics', '/proj/A')`);
    insMsg(db, "skA", T0, 50, 0);
    const ctx = { db, json: (b: unknown, status = 200) => Response.json(b, { status }), errorResponse: (s: number, m: string) => Response.json({ error: m }, { status: s }) } as never;
    const router = createUsageRouter(ctx);
    const req = new Request("http://x/api/usage/projects/quota");
    const res = await router(req, new URL(req.url), "/api/usage/projects/quota", "GET");
    expect(res!.status).toBe(200);
    const body = await res!.json() as { cachedAt: string; quotaHistory: boolean; projects: Array<{ projectPath: string | null }> };
    expect(typeof body.cachedAt).toBe("string");
    expect(body.projects.some((p) => p.projectPath === "/proj/A")).toBe(true);
  });
});

describe("projectPointsInWindow (the CLI probe's window, not projectQuota's fixed 24h/7d)", () => {
  test("totals the whole arbitrary window as one bucket", async () => {
    const db = makeDb();
    db.run(`INSERT INTO topics (id, session_key, provider, project_path) VALUES ('tA', 'skA', 'topics', '/proj/A')`);
    insMsg(db, "skA", T0, 300, 0);
    const history = [
      { t: Math.floor(HOUR_START / 1000) - 60, s: { "claude|acc1|7d": 0 } },
      { t: Math.floor(T0 / 1000), s: { "claude|acc1|7d": 10 } },
    ];
    const historyFile = `/tmp/project-quota-window-${Date.now()}.jsonl`;
    await Bun.write(historyFile, history.map((l) => JSON.stringify(l)).join("\n"));
    const result = projectPointsInWindow(db, T0 - 60_000, T0 + 60_000, { historyFile, listOutsideTranscripts: () => [] });
    const a = result.projects.find((p) => p.projectPath === "/proj/A");
    expect(a?.points).toBe(10); // the only call in the window gets the whole hour's rise
  });
});

describe("collectProjectCalls", () => {
  test("a usage_records row with no project_path and no linked topic has folder null", () => {
    const db = makeDb();
    db.run(`INSERT INTO usage_records (timestamp, session_key, model, input_tokens, output_tokens, measured) VALUES (?, 'sk', 'm', 10, 0, 1)`, [T0]);
    const calls = collectProjectCalls(db, { sinceMs: T0 - 60_000, untilMs: T0 + 60_000, listOutsideTranscripts: () => [] });
    expect(calls.some((c) => c.folder === null)).toBe(true);
  });
});
