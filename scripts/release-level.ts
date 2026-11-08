#!/usr/bin/env bun
/**
 * scripts/release-level.ts - which number of x.y.z the next release raises.
 *
 * WHY IT EXISTS. Until 2026-10-16 the auto-bump raised the PATCH and nothing
 * else: 2.2.0 on 23/07, 2.2.517 on 16/10, and a minor or a major only by hand,
 * which nobody did. Five hundred patches say nothing to whoever reads the
 * number: a release that changes what people see looked the same as a
 * one-line fix.
 *
 * THE CRITERION (RELEASE-07):
 *   - patch: the default, every green tip of main, as before;
 *   - minor: a change whoever uses Topics can see, a new feature or a changed
 *     behaviour;
 *   - major: only a break - data the previous version cannot read, a protocol
 *     that forces client, server and phone to update together, a supported
 *     system dropped.
 *
 * WHO DECIDES. The commit does, with a trailer line on its own: `Release: minor`
 * or `Release: major`. Main is squash-merged, so the line goes in the body of
 * the squash commit. Releases come out in batches (`release-gate.ts`), and a
 * batch takes the highest level among the commits since the last version
 * commit: a minor merged next to three fixes is still a minor.
 *
 * WHY THE RANGE MATTERS MOST. Count one commit from before the last release
 * and every release after it repeats that commit's minor, forever. The range
 * starts at the last `chore(release):` commit, which only the auto-bump writes.
 */
import { spawnSync } from "node:child_process";

export type ReleaseLevel = "patch" | "minor" | "major";

const RANK: Record<ReleaseLevel, number> = { patch: 0, minor: 1, major: 2 };

/** A trailer is a line of its own; the same words inside a sentence are not one. */
const TRAILER = /^release:[ \t]*(minor|major)[ \t]*$/gim;

/** Prefix of the version commit the auto-bump writes; same as `release-gate.ts`. */
const BUMP_SUBJECT = "^chore\\(release\\): bump v";

/** The level one commit message asks for. */
export function levelOf(message: string): ReleaseLevel {
  let level: ReleaseLevel = "patch";
  for (const m of message.matchAll(TRAILER)) {
    const asked = m[1].toLowerCase() as ReleaseLevel;
    if (RANK[asked] > RANK[level]) level = asked;
  }
  return level;
}

/** The level of a batch: the highest any of its commits asks for. */
export function decideLevel(messages: string[]): ReleaseLevel {
  let level: ReleaseLevel = "patch";
  for (const message of messages) {
    const asked = levelOf(message);
    if (RANK[asked] > RANK[level]) level = asked;
  }
  return level;
}

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout;
}

/** The messages of the commits since the last version commit, oldest last. */
export function messagesSinceLastRelease(cwd: string): string[] {
  const last = git(cwd, ["log", "-1", "--format=%H", "-E", `--grep=${BUMP_SUBJECT}`, "HEAD"]).trim();
  const range = last ? `${last}..HEAD` : "HEAD";
  return git(cwd, ["log", "--format=%B%x00", range])
    .split("\0")
    .map((m) => m.trim())
    .filter(Boolean);
}

/**
 * CLI shape: prints the level alone on stdout, so the workflow can write
 * `bump-version.sh "$(bun run scripts/release-level.ts)"`, and the reason on
 * stderr for whoever reads the job log.
 */
function main(): void {
  const messages = messagesSinceLastRelease(process.cwd());
  const level = decideLevel(messages);
  console.log(level);
  console.error(`[release-level] ${level}: ${messages.length} commit(s) since the last release.`);
}

// Runs only when this file IS the process, so the test can import the functions.
if (import.meta.main) main();
