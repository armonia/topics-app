#!/usr/bin/env bun
/**
 * Prints each project's share of the weekly Claude quota over an arbitrary
 * past window — the probe behind USAGE-28's acceptance bar, which asks for a
 * specific window (2026-11-17 14:54 → 2026-11-18 00:00) that `--days` cannot
 * express.
 *
 * Read-only: open a COPY of the live database with `--db` rather than the one
 * the server has open.
 *
 *   bun scripts/project-quota-check.ts --since 2026-11-17T14:54 --until 2026-11-18T00:00 [--db PATH]
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { projectPointsInWindow } from "../server/usage/project-quota";

export function defaultDbPath(): string {
  return process.env.DATA_DIR
    ? join(process.env.DATA_DIR, "topics.db")
    : join(import.meta.dir, "..", "data", "topics.db");
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function formatReport(result: ReturnType<typeof projectPointsInWindow>): string {
  const lines: string[] = [];
  if (!result.quotaHistory) lines.push("(no quota history: weighted tokens only, no points)");
  lines.push("project".padEnd(28) + "points".padStart(10));
  for (const p of result.projects) {
    const name = p.projectId ?? "(outside projects)";
    const points = p.points !== null ? p.points.toFixed(1) : String(p.weighted);
    lines.push(name.padEnd(28) + points.padStart(10));
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const since = flag(argv, "--since");
  const until = flag(argv, "--until");
  if (!since || !until) {
    console.error("usage: project-quota-check.ts --since <ISO> --until <ISO> [--db PATH]");
    process.exit(2);
  }
  const sinceMs = Date.parse(since);
  const untilMs = Date.parse(until);
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs)) {
    console.error(`unparseable --since/--until: ${since} / ${until}`);
    process.exit(2);
  }
  const dbPath = flag(argv, "--db") ?? defaultDbPath();
  if (!existsSync(dbPath)) {
    console.error(`no database at ${dbPath} - pass --db <path>`);
    process.exit(2);
  }
  const db = new Database(dbPath, { readonly: true });
  const result = projectPointsInWindow(db, sinceMs, untilMs);
  console.log(formatReport(result));
}

if (import.meta.main) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
