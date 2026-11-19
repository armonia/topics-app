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
  let d: { jobs?: unknown } | null;
  try { d = JSON.parse(stdout) as { jobs?: unknown } | null; } catch { return null; }
  if (!Array.isArray(d?.jobs)) return null;
  return (d.jobs as Array<{ id?: unknown; name?: unknown; state?: { lastRunAtMs?: unknown } } | null>).flatMap((j): JobHead[] => {
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
      let entries: Array<Record<string, unknown> | null> = [];
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
 * Recent runs with the tokens of the chat turns they started. Agent jobs run in a topic named after the
 * job, and the tokens live on its assistant messages (ISO timestamps), so they are summed from `messages`
 * inside the run window; command jobs have none and read 0.
 */
interface CronRunDbRow {
  job_id: string; job_name: string; run_at: number; ended_at: number | null; duration_ms: number | null;
  status: string; error: string | null; output: string | null;
}

export function listCronRuns(db: Database, opts: { jobId?: string | null; limit?: number } = {}): CronRunRow[] {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
  const runs = db.query(
    `SELECT job_id, job_name, run_at, ended_at, duration_ms, status, error, output FROM cron_runs
     WHERE (?1 IS NULL OR job_id = ?1) ORDER BY run_at DESC LIMIT ?2`,
  ).all(opts.jobId ?? null, limit) as CronRunDbRow[];
  // Per run, not one big join: the time index narrows each lookup to the run window.
  const tokens = db.query(
    `SELECT COALESCE(SUM(m.usage_prompt_tokens), 0) AS i, COALESCE(SUM(m.usage_completion_tokens), 0) AS o, SUM(m.cost_cents) AS c
     FROM messages m JOIN topics t ON t.session_key = m.session_key
     WHERE t.name = ?3 AND m.role = 'assistant' AND m.timestamp BETWEEN ?1 AND ?2`,
  );
  return runs.map((r) => {
    const t = tokens.get(new Date(r.run_at).toISOString(), new Date((r.ended_at ?? r.run_at) + 60_000).toISOString(), r.job_name) as { i: number; o: number; c: number | null };
    return {
      jobId: r.job_id, jobName: r.job_name, runAt: r.run_at, endedAt: r.ended_at, durationMs: r.duration_ms,
      status: r.status, error: r.error, output: r.output, inputTokens: t.i, outputTokens: t.o, costUsd: t.c === null ? null : t.c / 100,
    };
  });
}
