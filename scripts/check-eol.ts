#!/usr/bin/env bun
/**
 * scripts/check-eol.ts: a branch must not rewrite the line endings of a file.
 *
 * A checkout on a Windows PC with core.autocrlf=true commits a file whole in
 * CRLF: thousands of changed lines for two real ones, and a review nobody can
 * read. `.gitattributes` (`* text=auto eol=lf`) makes git normalize on add;
 * this check is the refusal behind it, for a clone where the attribute is
 * missing or overridden.
 *
 * Rule: a file added or modified between BASE and HEAD fails when its HEAD
 * content has CRLF and its BASE content had none (new files count as none).
 *
 * Usage: `bun run scripts/check-eol.ts [base] [head]`, base defaults to
 * the merge base with origin/main (a local `main` in a worktree can lag). Exits 1 listing the offenders.
 */
import { execFileSync } from "child_process";

const git = (cwd: string, args: string[]): Buffer =>
  execFileSync("git", args, { cwd, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

const hasCrlf = (buf: Buffer): boolean => buf.includes(Buffer.from("\r\n"));
const isBinary = (buf: Buffer): boolean => buf.includes(0);

export function findCrlfRewrites(cwd: string, base: string, head = "HEAD"): string[] {
  const changed = git(cwd, ["diff", "--name-only", "--no-renames", "--diff-filter=AM", "-z", base, head])
    .toString("utf8").split("\0").filter(Boolean);
  const offenders: string[] = [];
  for (const path of changed) {
    const after = git(cwd, ["show", `${head}:${path}`]);
    if (isBinary(after) || !hasCrlf(after)) continue;
    let before: Buffer | null = null;
    try { before = git(cwd, ["show", `${base}:${path}`]); } catch { before = null; }
    if (before === null || !hasCrlf(before)) offenders.push(path);
  }
  return offenders;
}

if (import.meta.main) {
  const cwd = process.cwd();
  let base = process.argv[2];
  if (!base) {
    try { base = git(cwd, ["merge-base", "HEAD", "origin/main"]).toString("utf8").trim(); }
    catch {
      try { base = git(cwd, ["merge-base", "HEAD", "main"]).toString("utf8").trim(); }
      catch {
        // Shallow CI checkout: no history to compare with, so nothing to judge.
        console.log("check:eol: no merge base with origin/main reachable, skipped");
        process.exit(0);
      }
    }
  }
  const offenders = findCrlfRewrites(cwd, base, process.argv[3] ?? "HEAD");
  if (offenders.length > 0) {
    console.error(`check:eol: these files went from LF to CRLF (set core.autocrlf=false, core.eol=lf):\n${offenders.map((p) => `  ${p}`).join("\n")}`);
    process.exit(1);
  }
}
