/**
 * THE OLD GATEWAY'S NAME IS GONE FROM THE REPOSITORY, save a closed list.
 *
 * The external agent gateway Topics once relayed through was switched off for
 * good on 2026-11-03: chats run on Topics' own engine, Jarvis' channels and jobs
 * on `jarvis-channels`. Its provider, its socket client, its token and its
 * context routes were removed (change `openspec/changes/via-openclaw/`), and the
 * name goes with them, from code, interface, tests, scripts and documents.
 *
 * What may still carry it is a record, not a surface, and the list is closed
 * (the proposal of that change, "Elenco chiuso delle eccezioni"):
 *   - CHANGELOG.md and its generated in-app copy, the archived changes, bench results, the SQL migrations
 *     already applied: history, never rewritten;
 *   - server/lib/data-dir.ts: the legacy app data root, a folder that still
 *     exists on the machines that used it (moving it is a migration of its own);
 *   - this test and the change that removed the name.
 *
 * The name is spelled in pieces here so this file does not match itself by
 * accident; it stays on the list anyway. The bar of that change: putting the
 * name back in any other file turns this test red.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const NAME = "open" + "claw";

/** Paths allowed to carry the name: exact files, or prefixes ending in `/`. */
const ALLOWED: readonly string[] = [
  "CHANGELOG.md",
  // Generated from the git history by scripts/gen-changelog.mjs (which already
  // writes it with the name replaced): a record, like CHANGELOG.md.
  "client/public/changelog.json",
  "openspec/changes/archive/",
  "bench/results/",
  "server/db/migrations/",
  "server/lib/data-dir.ts",
  `tests/unit/no-${NAME}-name.test.ts`,
  `openspec/changes/via-${NAME}/`,
];

function isAllowed(path: string): boolean {
  return ALLOWED.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry));
}

/** Tracked text files whose content carries the name, case-insensitive. */
function filesWithName(): string[] {
  const res = spawnSync("git", ["grep", "-lIi", NAME], { cwd: ROOT, encoding: "utf8" });
  // git grep exits 1 when nothing matches: that is the clean case, not a failure.
  if (res.status === 1 && !res.stderr) return [];
  if (res.status !== 0) throw new Error(`git grep failed (exit ${res.status}): ${res.stderr}`);
  return res.stdout.split("\n").filter(Boolean);
}

describe("the old gateway's name", () => {
  test("appears only in the closed list of records", () => {
    const outside = filesWithName().filter((f) => !isAllowed(f));
    if (outside.length) {
      console.error(`Files carrying the old gateway's name outside the closed list (${outside.length}):\n  ${outside.join("\n  ")}`);
    }
    expect(outside).toEqual([]);
  });

  test("the list is a list of exact paths and folders, not a pattern that lets anything through", () => {
    expect(isAllowed("server/lib/data-dir.ts")).toBe(true);
    expect(isAllowed("server/db/migrations/20260101000000-x.sql")).toBe(true);
    expect(isAllowed("openspec/changes/archive/2026-01-01-x/proposal.md")).toBe(true);
    // A neighbour of an allowed file is not allowed.
    expect(isAllowed("server/lib/data-dir.test.ts")).toBe(false);
    expect(isAllowed("server/lib/other.ts")).toBe(false);
    expect(isAllowed("openspec/changes/other/proposal.md")).toBe(false);
    expect(isAllowed("CHANGELOG.md.bak")).toBe(false);
    expect(isAllowed("docs/CHANGELOG.md")).toBe(false);
  });
});
