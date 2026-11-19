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
  db.run(`CREATE TABLE usage_records (id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, session_key TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL)`);
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
    db.run(`INSERT INTO usage_records VALUES ('a', 3000100, 'cron:agentjob', 10, 5, 0.5), ('b', 3000200, 'cron:agentjob', 1, 1, NULL),
      ('c', 9000000, 'cron:agentjob', 99, 99, 9), ('d', 3000100, 'cron:other', 77, 77, 7)`);
    const [latest, failed] = listCronRuns(db);
    expect(latest).toMatchObject({ runAt: 3000000, status: "ok", inputTokens: 11, outputTokens: 6, costUsd: 0.5 });
    expect(failed).toMatchObject({ runAt: 1000, status: "error", error: "boom", inputTokens: 0 });
    expect(listCronRuns(db, { jobId: "none" })).toEqual([]);
  });
});
