#!/usr/bin/env bun
/**
 * scripts/check-backup-residue.ts - fail when a branch ADDS a tool's backup copy.
 *
 * WHY. `sed -i -e ...` on macOS reads `-e` as the backup suffix, so it leaves
 * `<file>-e` next to the edited file. A delivery once carried a 5567-line
 * `spec.md-e` that way: CI was green and nothing flagged it. Same family:
 * `.orig` and `.rej` (patch/merge) and `.bak`.
 *
 * Only files ADDED by the branch (against main, plus
 * anything staged or untracked) count, so old history never turns it red.
 *
 * Run: `bun run check:backup-residue`
 */
import { $ } from "bun";

/** Suffixes that mark a backup or reject file. `-e` is the BSD sed one. */
const RESIDUE = /(-e|\.orig|\.rej|\.bak)$/;

/** The paths among `paths` that look like a backup residue. */
export function findResidues(paths: string[]): string[] {
  return paths.filter((p) => RESIDUE.test(p));
}

async function sh(cmd: string): Promise<string> {
  try {
    return (await $`sh -c ${cmd}`.quiet().text()).trim();
  } catch {
    return "";
  }
}

/**
 * Files the branch added, plus staged and untracked ones.
 *
 * Compares TREES (two-dot diff), so it needs only the tip of main, not the
 * merge-base: a shallow CI checkout with a depth-1 fetch of main works.
 * Without any main ref it throws instead of passing blind.
 */
export async function addedPaths(): Promise<string[]> {
  let base = "";
  for (const ref of ["origin/main", "main"]) {
    base = await sh(`git rev-parse --verify -q ${ref}`);
    if (base) break;
  }
  if (!base) {
    throw new Error("no main ref to compare with (fetch origin/main first): refusing to pass blind");
  }
  const out: string[] = [];
  out.push(...(await sh(`git diff --name-only --diff-filter=A ${base} HEAD`)).split("\n"));
  out.push(...(await sh("git diff --name-only --diff-filter=A --cached")).split("\n"));
  out.push(...(await sh("git ls-files --others --exclude-standard")).split("\n"));
  return [...new Set(out.map((l) => l.trim()).filter(Boolean))];
}

if (import.meta.main) {
  let added: string[];
  try {
    added = await addedPaths();
  } catch (e) {
    console.error(`[check-backup-residue] ${(e as Error).message}`);
    process.exit(1);
  }
  const bad = findResidues(added);
  if (bad.length === 0) {
    console.log("[check-backup-residue] nessun residuo di backup aggiunto dal ramo.");
    process.exit(0);
  }
  console.error("[check-backup-residue] il ramo aggiunge residui di backup:\n");
  for (const f of bad) console.error(`  ${f}`);
  console.error(
    "\nTogli i file. Su macOS `sed -i -e` lascia `<file>-e`: usa `sed -i ''` (BSD) o niente -i.",
  );
  process.exit(1);
}
