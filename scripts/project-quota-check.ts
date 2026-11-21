#!/usr/bin/env bun
/**
 * Prints each project's share of the weekly Claude quota: points in the last
 * 24 hours and the last 7 days, the limit, and the split by surface. The probe
 * behind USAGE-28's bar, to compare with the quota history by hand.
 *
 * Read-only: open a COPY of the live database with `--db` rather than the one
 * the server has open.
 *
 *   bun scripts/project-quota-check.ts --db PATH [--now ISO]
 *
 * The quota history is read from `TOPICS_USAGE_HISTORY_DIR` (default
 * `~/.topics/usage-history`); without it only the weighted spend is real and
 * the points read as `-`.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { QUOTA_SURFACES, type ProjectQuotaResult } from "../shared/usage-shapes";
import { projectQuota } from "../server/usage/project-quota";

export function defaultDbPath(): string {
  return process.env.DATA_DIR
    ? join(process.env.DATA_DIR, "topics.db")
    : join(import.meta.dir, "..", "data", "topics.db");
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const fmt = (v: number | null) => (v === null ? "-" : v.toFixed(1));

export function formatReport(result: ProjectQuotaResult): string {
  const lines: string[] = [];
  if (!result.quotaHistory) lines.push("(no quota history: weighted spend only, no points)");
  lines.push("project".padEnd(30) + "24h".padStart(8) + "7d".padStart(8) + "limit".padStart(7) + "  surfaces (24h)");
  for (const p of result.projects) {
    const name = p.projectId ?? "(outside projects)";
    const limit = p.limit === null ? "none" : String(p.limit);
    const surfaces = QUOTA_SURFACES.filter((s) => (p.surfaces[s].points24h ?? 0) > 0).map((s) => `${s} ${fmt(p.surfaces[s].points24h)}`).join(", ");
    lines.push(name.padEnd(30).slice(0, 30) + fmt(p.points24h).padStart(8) + fmt(p.points7d).padStart(8) + limit.padStart(7) + "  " + surfaces);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const now = flag(argv, "--now");
  const nowMs = now ? Date.parse(now) : Date.now();
  if (!Number.isFinite(nowMs)) {
    console.error(`unparseable --now: ${now}`);
    process.exit(2);
  }
  const dbPath = flag(argv, "--db") ?? defaultDbPath();
  if (!existsSync(dbPath)) {
    console.error(`no database at ${dbPath} - pass --db <path>`);
    process.exit(2);
  }
  const db = new Database(dbPath, { readonly: true });
  console.log(formatReport(projectQuota(db, { now: nowMs })));
}

if (import.meta.main) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
