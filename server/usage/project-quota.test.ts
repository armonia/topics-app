/**
 * The project's share of the weekly quota: the count (nested transcripts,
 * model weight, a card that outlives its worktree, one folder under two
 * spellings, one-shot calls), the surfaces, the limit, and the sum.
 * @covers USAGE-28
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { projectIdForPath } from "../../shared/board";
import type { ProjectQuotaRow } from "../../shared/usage-shapes";
import { createUsageRouter } from "../routes/usage";
import { callWeight, listTranscripts } from "./project-calls";
import { pointsPerHour, type QuotaHistorySample } from "./person-usage";
import { projectQuota } from "./project-quota";

const QUOTA_MIGRATION = await Bun.file(new URL("../db/migrations/20261119000000-project-quota.sql", import.meta.url)).text();

const scratch = mkdtempSync(join(tmpdir(), "project-quota-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT NOT NULL DEFAULT '', path TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0)`);
  db.run(`CREATE TABLE worktrees (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, abs_path TEXT NOT NULL)`);
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', session_key TEXT NOT NULL, provider TEXT, project_path TEXT, model TEXT)`);
  db.run(`CREATE TABLE messages (id TEXT PRIMARY KEY, session_key TEXT NOT NULL, role TEXT NOT NULL, timestamp TEXT NOT NULL, model TEXT,
    usage_prompt_tokens INTEGER, usage_completion_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER, cache_creation_1h_tokens INTEGER)`);
  db.run(`CREATE TABLE subagents (id TEXT PRIMARY KEY, parent_session_key TEXT NOT NULL, session_key TEXT, claude_session_id TEXT, cwd TEXT NOT NULL,
    runtime TEXT NOT NULL DEFAULT 'claude-code', model TEXT, created_at TEXT NOT NULL)`);
  db.run(`CREATE TABLE usage_records (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), timestamp INTEGER NOT NULL, session_key TEXT NOT NULL,
    topic_id TEXT, model TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, purpose TEXT, provider TEXT,
    cache_read_tokens INTEGER, cache_creation_tokens INTEGER, cache_creation_1h_tokens INTEGER, measured INTEGER NOT NULL DEFAULT 1, project_path TEXT)`);
  db.run(`CREATE TABLE system_chats (topic_id TEXT PRIMARY KEY, kind TEXT NOT NULL, created_at TEXT NOT NULL)`);
  db.run(`CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, assigned_topic_id TEXT, chat_id TEXT,
    node_run_id TEXT, updated_at TEXT NOT NULL DEFAULT '', agent_tokens INTEGER NOT NULL DEFAULT 0, agent_cache_read_tokens INTEGER NOT NULL DEFAULT 0, agent_cost_cents INTEGER NOT NULL DEFAULT 0)`);
  db.run(`CREATE TABLE agent_spend (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, at TEXT NOT NULL, cents INTEGER NOT NULL, unpriced_cost_tokens INTEGER NOT NULL DEFAULT 0)`);
  db.run(`CREATE TABLE task_attempts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, topic_id TEXT)`);
  db.run(`CREATE TABLE claude_code_sessions (session_key TEXT PRIMARY KEY, claude_session_id TEXT NOT NULL)`);
  db.exec(QUOTA_MIGRATION);
  return db;
}

const HOUR_START = Date.parse("2026-11-17T15:00:00.000Z");
const T0 = HOUR_START + 5 * 60_000;
const NOW = T0 + 60_000;

/** The history lines of an account that rose by `rise` points inside T0's hour. */
function historyLines(rise: number): QuotaHistorySample[] {
  return [
    { t: Math.floor(HOUR_START / 1000) - 60, s: { "claude|acc1|7d": 0 } },
    { t: Math.floor(T0 / 1000), s: { "claude|acc1|7d": rise } },
  ];
}
function writeHistory(rise: number): string {
  const file = join(scratch, `history-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(file, historyLines(rise).map((l) => JSON.stringify(l)).join("\n"));
  return file;
}
const NO_HISTORY = join(scratch, "missing-history.jsonl");
const NONE = () => [];

function project(db: Database, path: string): string {
  const id = projectIdForPath(path);
  db.run("INSERT INTO projects (id, path) VALUES (?, ?)", [id, path]);
  return id;
}
function topic(db: Database, id: string, o: { path?: string | null; provider?: string | null; model?: string | null } = {}): string {
  db.run("INSERT INTO topics (id, name, session_key, provider, project_path, model) VALUES (?, ?, ?, ?, ?, ?)",
    [id, `name-${id}`, `sk-${id}`, o.provider === undefined ? "topics" : o.provider, o.path ?? null, o.model ?? null]);
  return `sk-${id}`;
}
function nativeCall(db: Database, sk: string, model: string | null, input: number, output = 0, ts = T0): void {
  db.run(`INSERT INTO messages (id, session_key, role, timestamp, model, usage_prompt_tokens, usage_completion_tokens, cache_read_tokens, cache_creation_tokens, cache_creation_1h_tokens)
    VALUES (lower(hex(randomblob(16))), ?, 'assistant', ?, ?, ?, ?, 0, 0, 0)`, [sk, new Date(ts).toISOString(), model, input, output]);
}
function nativeSubagent(db: Database, parentSk: string, id: string): string {
  db.run("INSERT INTO subagents (id, parent_session_key, session_key, cwd, runtime, created_at) VALUES (?, ?, ?, '/x', 'topics', ?)", [id, parentSk, `sk-${id}`, new Date(T0).toISOString()]);
  return `sk-${id}`;
}
function card(db: Database, topicId: string, projectId: string): void {
  db.run("INSERT INTO tasks (id, project_id, assigned_topic_id) VALUES (?, ?, ?)", [`task-${topicId}`, projectId, topicId]);
  db.run("INSERT INTO system_chats (topic_id, kind, created_at) VALUES (?, 'task', ?)", [topicId, new Date(T0).toISOString()]);
}
function transcriptLine(model: string, input: number, cwd: string, id: string): string {
  return JSON.stringify({ type: "assistant", uuid: id, timestamp: new Date(T0).toISOString(), cwd, message: { id, model, usage: { input_tokens: input, output_tokens: 0 } } });
}
function transcriptFile(name: string, lines: string[]): string {
  const path = join(scratch, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, lines.join("\n"));
  return path;
}
const row = (rows: ProjectQuotaRow[], path: string) => rows.find((p) => p.projectPath === path);
const projectRows = (rows: ProjectQuotaRow[]) => rows.filter((p) => p.projectId !== null);

describe("two projects in the same hour", () => {
  test("A gets 7.5 points, B 2.5, a worktree counts for its project", () => {
    const db = makeDb();
    const idB = project(db, "/proj/B");
    db.run("INSERT INTO worktrees (id, project_id, abs_path) VALUES ('wB', ?, '/worktrees/B-feature')", [idB]);
    nativeCall(db, topic(db, "tA", { path: "/proj/A" }), "claude-opus-5-5", 300_000);
    // Project B's call runs in a WORKTREE of B: a session Topics never opened, found by its cwd.
    const file = transcriptFile("outside/s1.jsonl", [transcriptLine("claude-opus-5-5", 100_000, "/worktrees/B-feature", "m1")]);
    const result = projectQuota(db, { now: NOW, historyFile: writeHistory(10), listTranscripts: () => [{ path: file, mtimeMs: T0, sessionId: "s1", nested: false }] });
    expect(row(result.projects, "/proj/A")?.points7d).toBe(7.5);
    expect(row(result.projects, "/proj/B")?.points7d).toBe(2.5);
  });
});

describe("the last 24 hours are a window of their own", () => {
  test("points from three days ago count in the week but not in the 24h the meter shows", () => {
    const db = makeDb();
    project(db, "/proj/A");
    const sk = topic(db, "tA", { path: "/proj/A" });
    const OLD_T = T0 - 3 * 24 * 60 * 60_000;
    nativeCall(db, sk, "claude-opus-5-5", 100_000, 0, OLD_T);
    nativeCall(db, sk, "claude-opus-5-5", 100_000, 0, T0);
    // The account rose 4 points three days ago and 6 more in T0's hour.
    const file = join(scratch, "history-three-days-apart.jsonl");
    writeFileSync(file, [
      { t: Math.floor(OLD_T / 1000) - 60, s: { "claude|acc1|7d": 0 } },
      { t: Math.floor(OLD_T / 1000), s: { "claude|acc1|7d": 4 } },
      { t: Math.floor(T0 / 1000), s: { "claude|acc1|7d": 10 } },
    ].map((l) => JSON.stringify(l)).join("\n"));
    const a = row(projectQuota(db, { now: NOW, historyFile: file, listTranscripts: NONE }).projects, "/proj/A")!;
    expect(a.points7d).toBe(10);
    expect(a.points24h).toBe(6);
  });
});

describe("1a: nested Claude Code transcripts", () => {
  test("the listing finds a session's own file and its subagents folder", () => {
    const root = join(scratch, "claude-projects");
    mkdirSync(join(root, "-some-dir", "sess-1", "subagents"), { recursive: true });
    writeFileSync(join(root, "-some-dir", "sess-1.jsonl"), "");
    writeFileSync(join(root, "-some-dir", "sess-1", "subagents", "agent-a.jsonl"), "");
    const files = listTranscripts(root).map((f) => `${f.sessionId}:${f.nested}`).sort();
    expect(files).toEqual(["sess-1:false", "sess-1:true"]);
  });

  test("a chat's subagent file counts for the chat's project as a chat subagent", () => {
    const db = makeDb();
    project(db, "/proj/A");
    const sk = topic(db, "tA", { path: "/proj/A", provider: "claude-code" });
    db.run("INSERT INTO claude_code_sessions (session_key, claude_session_id) VALUES (?, 'sess-1')", [sk]);
    const main = transcriptFile("nest/sess-1.jsonl", [transcriptLine("claude-opus-5-5", 100_000, "/proj/A", "a1")]);
    const sub = transcriptFile("nest/sess-1/subagents/agent-a.jsonl", [transcriptLine("claude-opus-5-5", 100_000, "/proj/A", "a2")]);
    const result = projectQuota(db, {
      now: NOW, historyFile: writeHistory(10),
      listTranscripts: () => [{ path: main, mtimeMs: T0, sessionId: "sess-1", nested: false }, { path: sub, mtimeMs: T0, sessionId: "sess-1", nested: true }],
    });
    const a = row(result.projects, "/proj/A")!;
    expect(a.surfaces.chat.points7d).toBe(5);
    expect(a.surfaces.chatSubagent.points7d).toBe(5);
    expect(a.surfaces.outside.points7d).toBe(0);
  });
});

describe("1b: the weight depends on the model", () => {
  test("a Haiku call weighs far less than the same tokens on Opus, by the repo's price list", () => {
    const tokens = { input: 100_000, output: 1_000, cacheWrite: 0, cacheRead: 0 };
    const opus = callWeight("claude-opus-5-5", tokens);
    const cheap = callWeight("claude-haiku-5-5", tokens);
    expect(cheap).toBeGreaterThan(0);
    expect(opus / cheap).toBeGreaterThan(10);
  });

  test("an unpriced model weighs as the fallback, never as free", () => {
    const tokens = { input: 1_000, output: 100, cacheWrite: 0, cacheRead: 0 };
    expect(callWeight("not-a-model", tokens)).toBe(callWeight("claude-opus-5-5", tokens));
    expect(callWeight(null, tokens)).toBe(callWeight("claude-opus-5-5", tokens));
  });

  test("the hour's points split by price: same tokens, Opus takes the larger share", () => {
    const db = makeDb();
    nativeCall(db, topic(db, "tA", { path: "/proj/A" }), "claude-opus-5-5", 100_000);
    nativeCall(db, topic(db, "tB", { path: "/proj/B" }), "claude-haiku-5-5", 100_000);
    const result = projectQuota(db, { now: NOW, historyFile: writeHistory(10), listTranscripts: NONE });
    expect(row(result.projects, "/proj/A")!.points7d!).toBeGreaterThan(9);
    expect(row(result.projects, "/proj/B")!.points7d!).toBeLessThan(1);
  });
});

describe("1c: a card stays on its project when its worktree is gone", () => {
  test("a card chat whose folder is registered nowhere counts for its task's project", () => {
    const db = makeDb();
    const id = project(db, "/proj/A");
    const sk = topic(db, "tCard", { path: "/gone/worktrees/A/dead-worktree" });
    card(db, "tCard", id);
    nativeCall(db, sk, "claude-opus-5-5", 100_000);
    const result = projectQuota(db, { now: NOW, historyFile: writeHistory(10), listTranscripts: NONE });
    const a = row(result.projects, "/proj/A")!;
    expect(a.points7d).toBe(10);
    expect(a.surfaces.card.points7d).toBe(10);
    expect(result.projects.find((p) => p.projectId === null)?.points7d ?? 0).toBe(0);
    expect(result.projects.some((p) => p.projectPath === "/gone/worktrees/A/dead-worktree")).toBe(false);
  });

  test("a card's Claude Code session in a deleted worktree stays on the project too", () => {
    const db = makeDb();
    const id = project(db, "/proj/A");
    const sk = topic(db, "tCard", { path: "/gone/worktrees/A/dead", provider: "claude-code" });
    card(db, "tCard", id);
    db.run("INSERT INTO claude_code_sessions (session_key, claude_session_id) VALUES (?, 'sess-card')", [sk]);
    const file = transcriptFile("card/sess-card.jsonl", [transcriptLine("claude-opus-5-5", 100_000, "/gone/worktrees/A/dead", "c1")]);
    const result = projectQuota(db, { now: NOW, historyFile: writeHistory(10), listTranscripts: () => [{ path: file, mtimeMs: T0, sessionId: "sess-card", nested: false }] });
    expect(row(result.projects, "/proj/A")!.surfaces.card.points7d).toBe(10);
  });
});

describe("1c: a deleted worktree still names its project", () => {
  test("a session in a folder under the worktrees root, with no row and no chat, counts for the project of that slug", () => {
    const db = makeDb();
    db.run("INSERT INTO projects (id, slug, path) VALUES (?, 'app-slug', '/proj/A')", [projectIdForPath("/proj/A")]);
    const root = join(scratch, "worktrees-root");
    const file = transcriptFile("gone/s1.jsonl", [transcriptLine("claude-opus-5-5", 100_000, join(root, "app-slug", "deleted-one"), "g1")]);
    const result = projectQuota(db, { now: NOW, historyFile: writeHistory(10), worktreesRoot: root, listTranscripts: () => [{ path: file, mtimeMs: T0, sessionId: "s1", nested: false }] });
    expect(row(result.projects, "/proj/A")!.surfaces.outside.points7d).toBe(10);
  });
});

describe("1d: one folder, one project", () => {
  test("a link, a trailing slash and a backslash spelling of the folder land on one project", () => {
    const real = join(scratch, "real-project").replace(/\\/g, "/");
    mkdirSync(real, { recursive: true });
    const link = join(scratch, "linked-project");
    symlinkSync(real, link, "junction");
    const db = makeDb();
    project(db, real);
    nativeCall(db, topic(db, "t1", { path: real }), "claude-opus-5-5", 100_000);
    nativeCall(db, topic(db, "t2", { path: link }), "claude-opus-5-5", 100_000);
    nativeCall(db, topic(db, "t3", { path: real + "/" }), "claude-opus-5-5", 100_000);
    nativeCall(db, topic(db, "t4", { path: real.replace(/\//g, "\\") }), "claude-opus-5-5", 100_000);
    const result = projectQuota(db, { now: NOW, historyFile: writeHistory(12), listTranscripts: NONE });
    expect(projectRows(result.projects)).toHaveLength(1);
    expect(projectRows(result.projects)[0]!.points7d).toBe(12);
  });

  test("an unregistered folder under two spellings is one project too", () => {
    const real = join(scratch, "unregistered");
    mkdirSync(real, { recursive: true });
    const link = join(scratch, "unregistered-link");
    symlinkSync(real, link, "junction");
    const db = makeDb();
    nativeCall(db, topic(db, "t1", { path: real }), "claude-opus-5-5", 100_000);
    nativeCall(db, topic(db, "t2", { path: link + "/" }), "claude-opus-5-5", 100_000);
    const result = projectQuota(db, { now: NOW, historyFile: writeHistory(10), listTranscripts: NONE });
    expect(projectRows(result.projects)).toHaveLength(1);
  });
});

describe("1e: one-shot calls and the home folder", () => {
  test("a title call counts for its chat's project, as a single call, even when it recorded the home folder", () => {
    const db = makeDb();
    project(db, "/proj/A");
    topic(db, "tA", { path: "/proj/A" });
    db.run(`INSERT INTO usage_records (timestamp, session_key, topic_id, model, input_tokens, output_tokens, measured, project_path)
      VALUES (?, 'sk-tA', 'tA', 'claude-haiku-5-5', 100000, 0, 1, ?)`, [T0, homedir()]);
    const result = projectQuota(db, { now: NOW, historyFile: writeHistory(10), listTranscripts: NONE });
    expect(row(result.projects, "/proj/A")!.surfaces.single.points7d).toBe(10);
    expect(result.projects.some((p) => p.projectPath === homedir())).toBe(false);
  });

  test("the home folder never becomes a project with a limit of its own", () => {
    const db = makeDb();
    nativeCall(db, topic(db, "tHome", { path: homedir() }), "claude-opus-5-5", 100_000);
    db.run(`INSERT INTO usage_records (timestamp, session_key, model, input_tokens, output_tokens, measured, project_path)
      VALUES (?, 'sk-none', 'claude-haiku-5-5', 1000, 0, 1, ?)`, [T0, homedir()]);
    const result = projectQuota(db, { now: NOW, historyFile: writeHistory(10), listTranscripts: NONE });
    expect(projectRows(result.projects)).toHaveLength(0);
    expect(result.projects.find((p) => p.projectId === null)?.limit).toBeNull();
  });
});

describe("surfaces, chats and limits", () => {
  test("card, chat, their subagents and the top chats are told apart", () => {
    const db = makeDb();
    const id = project(db, "/proj/A");
    const chat = topic(db, "tChat", { path: "/proj/A" });
    const cardSk = topic(db, "tCard", { path: "/proj/A" });
    card(db, "tCard", id);
    nativeCall(db, chat, "claude-opus-5-5", 100_000);
    nativeCall(db, cardSk, "claude-opus-5-5", 100_000);
    nativeCall(db, nativeSubagent(db, chat, "subChat"), "claude-opus-5-5", 100_000);
    nativeCall(db, nativeSubagent(db, cardSk, "subCard"), "claude-opus-5-5", 100_000);
    const result = projectQuota(db, { now: NOW, historyFile: writeHistory(8), listTranscripts: NONE });
    const a = row(result.projects, "/proj/A")!;
    expect([a.surfaces.chat, a.surfaces.card, a.surfaces.chatSubagent, a.surfaces.cardSubagent].map((s) => s.points7d)).toEqual([2, 2, 2, 2]);
    // A subagent's calls count for its root chat.
    expect(a.topChats.map((c) => [c.topicId, c.surface, c.points7d]).sort()).toEqual([["tCard", "card", 4], ["tChat", "chat", 4]]);
  });

  test("a project's row carries its limit: the default, a chosen one, and none", () => {
    const db = makeDb();
    const [, idB, idC] = ["/proj/A", "/proj/B", "/proj/C"].map((p) => project(db, p));
    db.run("INSERT INTO project_quota (project_id, limit_24h_pct, updated_at) VALUES (?, 20, 'x'), (?, NULL, 'x')", [idB!, idC!]);
    const result = projectQuota(db, { now: NOW, historyFile: NO_HISTORY, listTranscripts: NONE });
    expect(["/proj/A", "/proj/B", "/proj/C"].map((p) => row(result.projects, p)!.limit)).toEqual([10, 20, null]);
  });

  test("without quota history points are null and only the weighted spend is real", () => {
    const db = makeDb();
    nativeCall(db, topic(db, "tA", { path: "/proj/A" }), "claude-opus-5-5", 200);
    const result = projectQuota(db, { now: NOW, historyFile: NO_HISTORY, listTranscripts: NONE });
    expect(result.quotaHistory).toBe(false);
    const a = row(result.projects, "/proj/A")!;
    expect(a.points7d).toBeNull();
    expect(a.weighted7d).toBeGreaterThan(0);
  });
});

describe("the sum", () => {
  test("every project plus the outside bucket adds up to the quota the account lost", () => {
    const db = makeDb();
    project(db, "/proj/B");
    const a = topic(db, "tA", { path: "/proj/A" });
    nativeCall(db, a, "claude-opus-5-5", 120_000, 3_000);
    nativeCall(db, nativeSubagent(db, a, "sub"), "claude-sonnet-5-5", 400_000);
    nativeCall(db, topic(db, "tB", { path: "/proj/B" }), "claude-haiku-5-5", 900_000);
    db.run(`INSERT INTO usage_records (timestamp, session_key, topic_id, model, input_tokens, output_tokens, measured) VALUES (?, 'sk-tB', 'tB', 'claude-haiku-5-5', 5000, 100, 1)`, [T0]);
    const file = transcriptFile("sum/stray.jsonl", [transcriptLine("claude-opus-5-5", 50_000, join(scratch, "stray-folder"), "z1")]);
    const result = projectQuota(db, { now: NOW, historyFile: writeHistory(37), listTranscripts: () => [{ path: file, mtimeMs: T0, sessionId: "stray", nested: false }] });
    const total = result.projects.reduce((s, p) => s + (p.points7d ?? 0), 0);
    const readings = [...pointsPerHour(historyLines(37), NOW - 7 * 24 * 3_600_000, NOW).values()].reduce((s, x) => s + x, 0);
    expect(Math.abs(total - readings)).toBeLessThanOrEqual(0.5);
    expect(result.projects.find((p) => p.projectId === null)!.points7d!).toBeGreaterThan(0);
  });
});

describe("GET /api/usage/projects/quota", () => {
  test("answers the same result projectQuota would compute, with cachedAt and each project's limit", async () => {
    const db = makeDb();
    nativeCall(db, topic(db, "tA", { path: "/proj/A" }), "claude-opus-5-5", 50, 0, Date.now() - 60_000);
    const ctx = { db, json: (b: unknown, status = 200) => Response.json(b, { status }), errorResponse: (s: number, m: string) => Response.json({ error: m }, { status: s }) } as never;
    const router = createUsageRouter(ctx);
    const req = new Request("http://x/api/usage/projects/quota");
    // An empty home: the route lists the transcripts under it, and this machine's real ones are gigabytes.
    const realHome = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), "quota-home-"));
    let res: Response | null;
    try { res = await router(req, new URL(req.url), "/api/usage/projects/quota", "GET"); } finally { process.env.HOME = realHome; }
    expect(res!.status).toBe(200);
    const body = await res!.json() as { cachedAt: string; projects: Array<{ projectPath: string | null; limit: number | null }> };
    expect(typeof body.cachedAt).toBe("string");
    expect(body.projects.find((p) => p.projectPath === "/proj/A")?.limit).toBe(10);
  });
});

describe("a run on a node counts in the project of its card", () => {
  const nodeCard = (db: Database, id: string, projectId: string, o: { tokens: number; cents?: number }) => {
    db.run("INSERT INTO tasks (id, project_id, node_run_id, agent_tokens, agent_cost_cents, updated_at) VALUES (?, ?, 'run-1', ?, ?, ?)",
      [id, projectId, o.tokens, o.cents ?? 0, new Date(T0).toISOString()]);
    if (o.cents) db.run("INSERT INTO agent_spend (task_id, at, cents) VALUES (?, ?, ?)", [id, new Date(T0).toISOString(), o.cents]);
  };

  test("the node's booked spend raises its card's project, not the other active one", () => {
    const db = makeDb();
    const idB = project(db, "/proj/B");
    nativeCall(db, topic(db, "tA", { path: "/proj/A" }), "claude-opus-5-5", 300_000);
    const cents = Math.round(callWeight("claude-opus-5-5", { input: 100_000, output: 0, cacheWrite: 0, cacheRead: 0 }) / 10_000);
    nodeCard(db, "node-task", idB, { tokens: 100_000, cents });
    const result = projectQuota(db, { now: NOW, historyFile: writeHistory(10), listTranscripts: NONE });
    expect(row(result.projects, "/proj/B")?.points7d).toBeCloseTo(2.5, 0);
    expect(row(result.projects, "/proj/B")?.surfaces.card.points7d).toBeGreaterThan(2);
    expect(row(result.projects, "/proj/A")?.points7d).toBeCloseTo(7.5, 0);
  });

  test("a node card with tokens and no priced ledger still counts, once, by its tokens", () => {
    const db = makeDb();
    const idB = project(db, "/proj/B");
    nativeCall(db, topic(db, "tA", { path: "/proj/A" }), "claude-opus-5-5", 300_000);
    nodeCard(db, "node-task", idB, { tokens: 100_000 });
    const result = projectQuota(db, { now: NOW, historyFile: writeHistory(10), listTranscripts: NONE });
    expect(row(result.projects, "/proj/B")?.points7d).toBe(2.5);
  });
});
