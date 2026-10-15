/**
 * Slow SQL in the log: which statement held the event loop.
 *
 * A `[LAG]` line says that the loop stopped, not why. Sampling the live server
 * during a stall (15/10/2026, macOS `sample` on the main thread) found it in
 * `sqlite3_step`, walking a b-tree and waiting on `pread`: the system SQLite
 * keeps its page cache in purgeable memory, which the kernel drops under
 * memory pressure, so a scan that is instant on a warm cache goes back to the
 * disk while swap is busy with it. JS frames are anonymous in a native sample,
 * so the sample cannot say WHICH statement. This module can: every statement
 * run through `query`, `prepare` or `run` is timed, and one slower than
 * `SLOW_SQL_MS` prints its SQL.
 *
 * At most one line per statement per minute: under pressure the same query is
 * slow on every call, and the count of the calls in between rides on the next
 * line. `iterate()` is not timed: it steps lazily, after the call returns.
 */
import type { Database, Statement } from "bun:sqlite";

export const SLOW_SQL_MS = 250;
const REPEAT_MS = 60_000;
const SQL_CHARS = 200;
const TIMED_METHODS = ["all", "get", "run", "values"] as const;

export interface SlowStatementOptions {
  thresholdMs?: number;
  log?: (line: string) => void;
  now?: () => number;
}

export function instrumentSlowStatements(db: Database, opts: SlowStatementOptions = {}): void {
  const thresholdMs = opts.thresholdMs ?? SLOW_SQL_MS;
  const log = opts.log ?? ((line: string) => console.warn(line));
  const now = opts.now ?? (() => performance.now());
  // `query()` hands back the SAME cached statement for the same SQL: wrapping
  // it again on every call would time it once per earlier call.
  const timedStatements = new WeakSet<object>();
  const lastLine = new Map<string, { at: number; skipped: number }>();

  function report(sql: string, method: string, ms: number, result: unknown, at: number): void {
    const seen = lastLine.get(sql);
    if (seen && at - seen.at < REPEAT_MS) {
      seen.skipped++;
      return;
    }
    const rows = Array.isArray(result) ? ` rows=${result.length}` : "";
    const skipped = seen?.skipped ? ` (+${seen.skipped} slow in the last minute)` : "";
    const text = sql.replace(/\s+/g, " ").trim().slice(0, SQL_CHARS);
    log(`[DB-SLOW] ${Math.round(ms)}ms ${method}${rows}${skipped} ${text}`);
    lastLine.set(sql, { at, skipped: 0 });
  }

  function timed<T>(sql: string, method: string, call: () => T): T {
    const start = now();
    let result: unknown;
    try {
      result = call();
      return result as T;
    } finally {
      const end = now();
      if (end - start >= thresholdMs) report(sql, method, end - start, result, end);
    }
  }

  function timeStatement<S extends Statement>(statement: S, sql: string): S {
    if (timedStatements.has(statement)) return statement;
    timedStatements.add(statement);
    const target = statement as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const method of TIMED_METHODS) {
      const original = target[method];
      if (typeof original !== "function") continue;
      target[method] = (...args: unknown[]) => timed(sql, method, () => original.apply(statement, args));
    }
    return statement;
  }

  const handle = db as unknown as Record<string, (...args: unknown[]) => unknown>;
  const query = db.query.bind(db);
  const prepare = db.prepare.bind(db) as (...args: unknown[]) => Statement;
  const run = db.run.bind(db) as (...args: unknown[]) => unknown;
  handle.query = (sql: unknown) => timeStatement(query(sql as string), sql as string);
  handle.prepare = (sql: unknown, ...rest: unknown[]) => timeStatement(prepare(sql, ...rest), sql as string);
  handle.run = (sql: unknown, ...rest: unknown[]) => timed(sql as string, "run", () => run(sql, ...rest));
}
