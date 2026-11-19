/**
 * Scheduler runs copied into Topics: outcome kept, tokens joined from the usage log, no run lost or doubled.
 * The scheduler is a fake CLI; no real job is touched.
 * @covers CRONRUNS-01
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { listCronRuns, syncCronRuns } from "./cron-runs";
import type { CronCli } from "../routes/cron";

function freshDb() {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE cron_runs (job_id TEXT NOT NULL, job_name TEXT NOT NULL, run_at INTEGER NOT NULL, ended_at INTEGER, duration_ms INTEGER,
    status TEXT NOT NULL, error TEXT, output TEXT, PRIMARY KEY (job_id, run_at))`);
  db.run(`CREATE TABLE topics (session_key TEXT PRIMARY KEY, name TEXT)`);
  db.run(`CREATE TABLE messages (id INTEGER PRIMARY KEY, session_key TEXT, role TEXT, timestamp TEXT, usage_prompt_tokens INTEGER, usage_completion_tokens INTEGER, cost_cents INTEGER)`);
  return db;
}

const listing = (last: number) => JSON.stringify({ jobs: [
  { id: "agentjob", name: "Agent job", state: { lastRunAtMs: last } },
  { id: "never", name: "Never ran", state: { lastRunAtMs: null } },
] });
const runs = (...at: number[]) => JSON.stringify({ entries: at.map((t) => ({ runAtMs: t, ts: t + 5000, durationMs: 5000, status: t === 1000 ? "error" : "ok", error: t === 1000 ? "boom" : null, output: "out" })) });

function cliFor(last: number, entries: string): { cli: CronCli; calls: string[][] } {
  const calls: string[][] = [];
  const cli: CronCli = async (args) => {
    calls.push(args);
    return { ok: true, stdout: args[0] === "list" ? listing(last) : entries };
  };
  return { cli, calls };
}

describe("syncCronRuns", () => {
  test("stores every run once and a second sync adds nothing", async () => {
    const db = freshDb();
    const { cli, calls } = cliFor(3000, runs(3000, 2000, 1000));
    expect(await syncCronRuns(db, cli)).toEqual({ ok: true, inserted: 3, jobsFetched: 1 });
    expect(calls.filter((c) => c[0] === "runs")).toHaveLength(1);
    const again = cliFor(3000, runs(3000, 2000, 1000));
    expect(await syncCronRuns(db, again.cli)).toEqual({ ok: true, inserted: 0, jobsFetched: 0 });
    expect(again.calls.filter((c) => c[0] === "runs")).toHaveLength(0);
  });

  test("a scheduler that does not answer reports the failure", async () => {
    const r = await syncCronRuns(freshDb(), async () => ({ ok: false, status: 502, message: "down" }));
    expect(r).toEqual({ ok: false, message: "down" });
  });
});

describe("listCronRuns", () => {
  test("keeps the error and sums the tokens inside the run window only", async () => {
    const db = freshDb();
    await syncCronRuns(db, cliFor(3000000, runs(3000000, 1000)).cli).then(() => {});
    db.run(`INSERT INTO topics VALUES ('topic:1', 'Agent job'), ('topic:2', 'Other job')`);
    const at = (ms: number) => new Date(ms).toISOString();
    const inserted = db.query(`INSERT INTO messages (session_key, role, timestamp, usage_prompt_tokens, usage_completion_tokens, cost_cents) VALUES (?, ?, ?, ?, ?, ?)`);
    inserted.run("topic:1", "assistant", at(3000100), 10, 5, 50);
    inserted.run("topic:1", "assistant", at(3000200), 1, 1, null);
    inserted.run("topic:1", "user", at(3000150), 500, 500, 500);
    inserted.run("topic:1", "assistant", at(9000000), 99, 99, 900);
    inserted.run("topic:2", "assistant", at(3000100), 77, 77, 700);
    const [latest, failed] = listCronRuns(db);
    expect(latest).toMatchObject({ runAt: 3000000, status: "ok", inputTokens: 11, outputTokens: 6, costUsd: 0.5 });
    expect(failed).toMatchObject({ runAt: 1000, status: "error", error: "boom", inputTokens: 0 });
    expect(listCronRuns(db, { jobId: "none" })).toEqual([]);
  });
});
