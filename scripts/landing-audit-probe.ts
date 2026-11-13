#!/usr/bin/env bun
/**
 * THE LANDING AUDIT, MEASURED ON A REAL BOARD WITHOUT TOUCHING IT.
 *
 *   bun run scripts/landing-audit-probe.ts --db <path to topics.db>
 *
 * Runs the very pass the server runs (`runLandingAudit`, same verdicts, same
 * main: origin/main where the repo has one) over EVERY card the audit could
 * ask, settled ones included, and prints the audit's own line plus the split
 * by column and verdict. Read-only: the database is opened `readonly`, verdicts
 * and comments go to this process's memory, git only reads (the revert check
 * uses a private index in the temp dir).
 *
 * Why it exists (card 206fe874): "22/22 delivered cards are NOT on main" was
 * printed on every pass and nobody could say whether it was true. This answers
 * with the whole population instead of the cards one pass happens to re-ask.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runLandingAudit } from "../server/services/landing-audit-pass";
import { listLandingAuditCandidates } from "../server/services/landing-candidates";
import type { AuditTask, LandingState } from "../server/services/landing-audit";
import type { ProjectStore } from "../server/services/project-store";
import { resolveAppDataDir } from "../server/lib/data-dir";

const argv = process.argv.slice(2);
const at = argv.indexOf("--db");
const dbPath = (at >= 0 ? argv[at + 1] : undefined) ?? join(resolveAppDataDir(), "data", "topics.db");
if (!existsSync(dbPath)) {
  console.error(`no database at ${dbPath}: pass --db <path>`);
  process.exit(2);
}
const db = new Database(dbPath, { readonly: true });

const paths = new Set<string>();
const collect = (sql: string) => {
  try { for (const r of db.prepare(sql).all() as Array<{ p: string | null }>) if (r.p) paths.add(r.p); } catch { /* table absent */ }
};
collect("SELECT path AS p FROM projects");
collect("SELECT DISTINCT project_path AS p FROM topics WHERE project_path IS NOT NULL");

// A date far ahead: the "settled verdicts wait a day" filter then lets every
// settled card through, so the count covers the population, not one pass.
const candidates = listLandingAuditCandidates(db, "2999-01-01T00:00:00.000Z");
const byId = new Map<string, AuditTask & { landingState: LandingState | null; status: string }>();
// The stored verdict, as the server would see it: a card with no commit is
// re-asked only when it already carries an accusation to withdraw.
const storedState = db.prepare<{ s: LandingState | null }, [string]>("SELECT landing_state AS s FROM tasks WHERE id = ?");
for (const c of candidates) byId.set(c.id, { ...c, landingState: storedState.get(c.id)?.s ?? null });
const verdicts = new Map<string, LandingState>();

await runLandingAudit({
  projectStore: { list: () => [] } as unknown as ProjectStore,
  workspaceDir: join(resolveAppDataDir(), "workspace"),
  extraPaths: () => [...paths],
  svc: {
    addComment: () => null,
    get: (id) => { const t = byId.get(id); return t ? { task: t } : null; },
    recordLandingState: (a) => { verdicts.set(a.taskId, a.state); return null; },
    listLandingAuditCandidates: () => candidates,
  },
  broadcast: () => {},
  backfill: async () => {},
});

const table = new Map<string, number>();
for (const [id, state] of verdicts) {
  const key = `${byId.get(id)?.status ?? "?"}\t${state}`;
  table.set(key, (table.get(key) ?? 0) + 1);
}
const stored = db.prepare(
  `SELECT status, landing_state AS s, COUNT(*) AS n FROM tasks
    WHERE archived = 0 AND status IN ('review','done')
      AND (COALESCE(landing_witnessed,0) = 1 AND landing_state = 'landed' OR landing_state IN ('superseded','unpushed'))
    GROUP BY status, landing_state`,
).all() as Array<{ status: string; s: string; n: number }>;

console.log(`\ncards listed: ${candidates.length} (every review/done card the audit can ask, settled included); answered: ${verdicts.size}`);
console.log("(a card with only a branch and no accusation is listed but has nothing to verify yet)");
for (const [key, n] of [...table].sort()) console.log(`  ${key.replace("\t", " / ")}: ${n}`);
console.log("not asked by the audit by design (witnessed landed, superseded, unpushed):");
for (const r of stored) console.log(`  ${r.status} / ${r.s}: ${r.n}`);
