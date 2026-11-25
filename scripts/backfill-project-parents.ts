#!/usr/bin/env bun
/**
 * Gives a parent project to the projects that are really worktrees (see
 * `server/services/project-family-backfill.ts`). The server does the same at
 * boot; this is the manual door, with a dry run first.
 *
 *   bun scripts/backfill-project-parents.ts [--db <path>]            dry run, prints the plan
 *   bun scripts/backfill-project-parents.ts [--db <path>] --apply    writes parent_id
 *
 * Only `projects.parent_id` changes. Exit 1 when a worktree-project has no parent to give.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { backfillProjectParents } from "../server/services/project-family-backfill";
import { rootsOfDatabase } from "../server/services/worktree-root-check";

const at = process.argv.indexOf("--db");
const dbPath = at >= 0 && process.argv[at + 1]
  ? process.argv[at + 1]!
  : process.env.TOPICS_DB ?? join(process.env.DATA_DIR ?? join(import.meta.dir, "..", "data"), "topics.db");
const apply = process.argv.includes("--apply");

// The root this database's settings name (the env override still wins), not the default of whoever runs this.
const worktreeRoot = rootsOfDatabase(dbPath).root;
const db = new Database(dbPath, apply ? undefined : { readonly: true });
try {
  const r = backfillProjectParents(db, { worktreeRoot, apply });
  for (const a of r.assigned) console.log(`${apply ? "set     " : "would set"}  ${a.slug.padEnd(24)} -> ${a.parentSlug}`);
  for (const u of r.unresolved) console.log(`no parent  ${u.slug.padEnd(24)} ${u.path}`);
  console.log(`${r.assigned.length} ${apply ? "assigned" : "to assign"}, ${r.unresolved.length} without a parent`);
  process.exit(r.unresolved.length > 0 ? 1 : 0);
} finally {
  db.close();
}
