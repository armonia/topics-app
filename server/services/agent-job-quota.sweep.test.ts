/**
 * @covers KANBAN-16
 */
// agent-job-quota.sweep.test.ts — who may sweep the job-quota channel folders, and what they spare.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import { delimiter, join } from "node:path";
import { TERMINAL_SESSIONS_DDL } from "../db/test-schema";
import {
  JOB_QUOTA_GC_GRACE_MS,
  _resetJobQuotaState,
  gcJobQuotaChannels,
  quotaChannelDir,
  refreshLiveJobQuotas,
  writeLiveQuota,
} from "./agent-job-quota";

const roots: string[] = [];
function temporaryRoot(): string {
  const dir = mkdtempSync(join(os.tmpdir(), "job-quota-sweep-"));
  roots.push(dir);
  process.env.TOPICS_JOB_QUOTA_DIR = dir;
  return dir;
}
afterEach(() => {
  delete process.env.TOPICS_JOB_QUOTA_DIR;
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dbVivo(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY, session_key TEXT NOT NULL UNIQUE)`);
  db.run(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, assigned_topic_id TEXT REFERENCES topics(id), dispatch_weight TEXT,
    status TEXT NOT NULL DEFAULT 'in_progress', dispatch_state TEXT, archived INTEGER NOT NULL DEFAULT 0
  )`);
  db.run(`CREATE TABLE task_attempts (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, idx INTEGER NOT NULL, topic_id TEXT,
    state TEXT NOT NULL DEFAULT 'running'
  )`);
  db.run(TERMINAL_SESSIONS_DDL);
  db.run(`CREATE TABLE board_settings (
    project_id TEXT PRIMARY KEY, max_agents INTEGER, max_agents_auto INTEGER
  )`);
  db.prepare("INSERT INTO board_settings (project_id, max_agents, max_agents_auto) VALUES ('*', 4, 0)").run();
  return db;
}

function aliveAgent(db: Database, n: number) {
  db.prepare("INSERT INTO topics (id, session_key) VALUES (?, ?)").run(`t${n}`, `topic:${n}`);
  db.prepare(
    "INSERT INTO tasks (id, assigned_topic_id, dispatch_weight, status, dispatch_state, archived) VALUES (?,?,?,?,?,0)",
  ).run(`k${n}`, `t${n}`, null, "in_progress", "working");
}

const LONG_AGO = Date.now() - 3 * JOB_QUOTA_GC_GRACE_MS;
const age = (sessionKey: string) => {
  utimesSync(quotaChannelDir(sessionKey), new Date(LONG_AGO), new Date(LONG_AGO));
};
function card(db: Database, n: number, status: string, archived = 0): string {
  const key = `topic:${n}`;
  db.prepare("INSERT INTO topics (id, session_key) VALUES (?, ?)").run(`t${n}`, key);
  db.prepare(
    "INSERT INTO tasks (id, assigned_topic_id, dispatch_weight, status, dispatch_state, archived) VALUES (?,?,?,?,?,?)",
  ).run(`k${n}`, `t${n}`, null, status, null, archived);
  writeLiveQuota(key, 2);
  age(key);
  return key;
}
const claim = (db: Database, root: string) => writeFileSync(join(root, ".owner-db"), `${db.filename || ":memory:"}\n`);
const sweep = (db: Database) => { claim(db, process.env.TOPICS_JOB_QUOTA_DIR!); _resetJobQuotaState(); return gcJobQuotaChannels(db); };

describe("the channel folders: who sweeps and what is spared", () => {
  /** Two instances on one HOME, each with its own database: the second one must not judge the first one's folders. */
  test("a root claimed by another database is not swept", () => {
    const root = temporaryRoot();
    const db = dbVivo();
    writeLiveQuota("topic:1", 2);
    age("topic:1");
    writeFileSync(join(root, ".owner-db"), "/somewhere/else/topics.db\n");
    _resetJobQuotaState();
    expect(gcJobQuotaChannels(db)).toBe(0);
    expect(existsSync(quotaChannelDir("topic:1"))).toBe(true);
  });

  test("a root nobody has written to through a database is not swept", () => {
    const root = temporaryRoot();
    const db = dbVivo();
    writeLiveQuota("topic:1", 2);
    age("topic:1");
    _resetJobQuotaState();
    expect(gcJobQuotaChannels(db)).toBe(0);
    expect(existsSync(join(root, ".owner-db"))).toBe(false);
    expect(existsSync(quotaChannelDir("topic:1"))).toBe(true);
  });

  test("the first refresh with a live agent claims the root for its database", () => {
    const root = temporaryRoot();
    const db = dbVivo();
    aliveAgent(db, 1);
    refreshLiveJobQuotas(db);
    expect(readFileSync(join(root, ".owner-db"), "utf8").trim()).toBe(":memory:");
  });

  test("the default root follows TOPICS_HOME, not the real home", () => {
    delete process.env.TOPICS_JOB_QUOTA_DIR;
    const prev = process.env.TOPICS_HOME;
    process.env.TOPICS_HOME = "/tmp/topics-home-probe";
    try {
      expect(quotaChannelDir("topic:1").startsWith("/tmp/topics-home-probe/job-quota/")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.TOPICS_HOME; else process.env.TOPICS_HOME = prev;
    }
  });

  /** A done card whose sub-agent is still active: the child's shims must outlive the card. */
  test("a live sub-agent keeps the channel of a done or archived card", () => {
    temporaryRoot();
    const db = dbVivo();
    const done = card(db, 1, "done");
    const archived = card(db, 2, "in_pr", 1);
    const gone = card(db, 3, "done");
    db.prepare(
      "INSERT INTO terminal_sessions (id, name, cwd, created_at, status, parent_session_key) VALUES (?,?,?,?,?,?)",
    ).run("c1", "child", "/tmp", "2026-01-01", "active", "topic:t1");
    db.prepare(
      "INSERT INTO terminal_sessions (id, name, cwd, created_at, status, parent_session_key) VALUES (?,?,?,?,?,?)",
    ).run("c2", "child", "/tmp", "2026-01-01", "active", "topic:t2");
    db.prepare(
      "INSERT INTO terminal_sessions (id, name, cwd, created_at, status, parent_session_key) VALUES (?,?,?,?,?,?)",
    ).run("c3", "child", "/tmp", "2026-01-01", "closed", "topic:t3");
    expect(sweep(db)).toBe(1);
    expect(existsSync(quotaChannelDir(done))).toBe(true);
    expect(existsSync(quotaChannelDir(archived))).toBe(true);
    expect(existsSync(quotaChannelDir(gone))).toBe(false);
  });

  test("a live agent's folder does not age while its number stays the same", () => {
    temporaryRoot();
    const db = dbVivo();
    aliveAgent(db, 1);
    refreshLiveJobQuotas(db);
    age("topic:1");
    refreshLiveJobQuotas(db);
    expect(statSync(quotaChannelDir("topic:1")).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
  });

  test("a live agent whose shims were swept gets them back on the next refresh", () => {
    temporaryRoot();
    const db = dbVivo();
    aliveAgent(db, 1);
    const prevPath = process.env.PATH;
    process.env.PATH = `/usr/bin${delimiter}/bin`;
    try {
      refreshLiveJobQuotas(db);
      rmSync(join(quotaChannelDir("topic:1"), "bin"), { recursive: true, force: true });
      refreshLiveJobQuotas(db);
      expect(existsSync(join(quotaChannelDir("topic:1"), "bin"))).toBe(true);
    } finally {
      process.env.PATH = prevPath;
    }
  });
});
