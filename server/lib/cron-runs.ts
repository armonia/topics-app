import type { Database } from "bun:sqlite";
import type { CronCli } from "../routes/cron";

export interface CronRunRow {
  jobId: string;
  jobName: string;
  runAt: number;
  endedAt: number | null;
  durationMs: number | null;
  status: string;
  error: string | null;
  output: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

const RUNS_PER_JOB = 50;
const OUTPUT_CAP = 1000;
const CONCURRENCY = 4;

interface JobHead { id: string; name: string; lastRunAtMs: number | null }

function parseHeads(stdout: string): JobHead[] | null {
  let d: any;
  try { d = JSON.parse(stdout); } catch { return null; }
  if (!Array.isArray(d?.jobs)) return null;
  return d.jobs.flatMap((j: any): JobHead[] => {
    if (typeof j?.id !== "string" || !j.id) return [];
    const last = j.state?.lastRunAtMs;
    return [{ id: j.id, name: typeof j.name === "string" && j.name ? j.name : j.id, lastRunAtMs: typeof last === "number" ? last : null }];
  });
}

/**
 * Copies finished runs from the scheduler into `cron_runs`. A job is fetched only when its
 * last run is newer than the newest one stored, so a quiet cycle costs one `list` call.
 * Idempotent on (job, start). Returns how many rows are new.
 */
export async function syncCronRuns(db: Database, cli: CronCli): Promise<{ ok: true; inserted: number; jobsFetched: number } | { ok: false; message: string }> {
  const listed = await cli(["list", "--json", "--all"]);
  if (!listed.ok) return { ok: false, message: listed.message };
  const heads = parseHeads(listed.stdout);
  if (!heads) return { ok: false, message: "cron list: the answer is not a job list" };

  const newest = new Map<string, number>(
    (db.query("SELECT job_id, MAX(run_at) AS t FROM cron_runs GROUP BY job_id").all() as { job_id: string; t: number }[]).map((r) => [r.job_id, r.t]),
  );
  const stale = heads.filter((h) => h.lastRunAtMs !== null && h.lastRunAtMs > (newest.get(h.id) ?? 0));

  const insert = db.query(
    `INSERT OR IGNORE INTO cron_runs (job_id, job_name, run_at, ended_at, duration_ms, status, error, output) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let inserted = 0;
  let next = 0;
  async function worker() {
    while (next < stale.length) {
      const h = stale[next++]!;
      const r = await cli(["runs", "--id", h.id, "--json", "--limit", String(RUNS_PER_JOB)]);
      if (!r.ok) continue; // one job failing must not hide the others; the next cycle retries it
      let entries: any[] = [];
      try { entries = JSON.parse(r.stdout)?.entries ?? []; } catch { continue; }
      for (const e of entries) {
        if (typeof e?.runAtMs !== "number") continue;
        const res = insert.run(
          h.id, h.name, e.runAtMs, typeof e.ts === "number" ? e.ts : null, typeof e.durationMs === "number" ? e.durationMs : null,
          typeof e.status === "string" ? e.status : "unknown",
          typeof e.error === "string" ? e.error.slice(0, OUTPUT_CAP) : null,
          typeof e.output === "string" ? e.output.slice(0, OUTPUT_CAP) : null,
        );
        inserted += res.changes;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, stale.length) }, worker));
  return { ok: true, inserted, jobsFetched: stale.length };
}

/**
 * Recent runs with the tokens of the chat turns they started. Agent jobs run as turns whose
 * session key carries the job id, so tokens are summed from `usage_records` inside the run window;
 * command jobs have none and read 0.
 */
export function listCronRuns(db: Database, opts: { jobId?: string | null; limit?: number } = {}): CronRunRow[] {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
  const runs = db.query(
    `SELECT job_id, job_name, run_at, ended_at, duration_ms, status, error, output FROM cron_runs
     WHERE (?1 IS NULL OR job_id = ?1) ORDER BY run_at DESC LIMIT ?2`,
  ).all(opts.jobId ?? null, limit) as any[];
  // Per run, not one big join: the time index narrows each lookup to the run window.
  const tokens = db.query(
    `SELECT COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o, SUM(cost_usd) AS c
     FROM usage_records WHERE timestamp BETWEEN ?1 AND ?2 AND instr(session_key, ?3) > 0`,
  );
  return runs.map((r) => {
    const t = tokens.get(r.run_at, (r.ended_at ?? r.run_at) + 60_000, r.job_id) as { i: number; o: number; c: number | null };
    return {
      jobId: r.job_id, jobName: r.job_name, runAt: r.run_at, endedAt: r.ended_at, durationMs: r.duration_ms,
      status: r.status, error: r.error, output: r.output, inputTokens: t.i, outputTokens: t.o, costUsd: t.c,
    };
  });
}
