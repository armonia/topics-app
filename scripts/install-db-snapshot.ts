#!/usr/bin/env bun
/**
 * Fills in a `scripts/launchd/com.armonia.topics-<job>.plist.in` template with
 * the paths of THIS machine and loads it. The job is the DB snapshot unless
 * `--job` names another template (`worktree-sweep`).
 *
 * The template is tracked and the filled-in plist is not, because this repo is
 * public and a concrete plist carries the home directory and the username of
 * whoever installed it. One did get committed on 22/10/2026 (PR #405) and CI
 * did not see it: the gate that looks for a home path looks for the home of
 * whoever RUNS it, which on a CI runner is nobody's.
 *
 *   bun scripts/install-db-snapshot.ts                       install and load
 *   bun scripts/install-db-snapshot.ts --print               print it, install nothing
 *   bun scripts/install-db-snapshot.ts --job worktree-sweep  the same for another job
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const jobFlag = process.argv.indexOf("--job");
const JOB = jobFlag >= 0 ? (process.argv[jobFlag + 1] ?? "") : "db-snapshot";
if (!/^[a-z][a-z-]*$/.test(JOB)) {
  console.error("--job needs the name of a template in scripts/launchd, e.g. worktree-sweep");
  process.exit(1);
}
const LABEL = `com.armonia.topics-${JOB}`;
/**
 * The MAIN checkout, not whichever one this script was launched from.
 *
 * The snapshot has to run where the production DB is. Launched from an agent's
 * worktree, `import.meta.dir/..` is that worktree, whose `data/topics.db` is a
 * different and empty file: the job would quietly back up nothing. The common
 * git dir belongs to the main worktree in every worktree of the repo.
 */
function mainCheckout(): string {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: import.meta.dir,
    encoding: "utf8",
    env: process.env,
  }).trim();
  return dirname(common);
}

const REPO = mainCheckout();
const TEMPLATE = resolve(import.meta.dir, "launchd", `${LABEL}.plist.in`);

/** The absolute bun, because launchd runs with a PATH of its own. */
function bunPath(): string {
  const own = process.execPath;
  if (own.endsWith("/bun")) return own;
  return execFileSync("/usr/bin/which", ["bun"], { encoding: "utf8", env: process.env }).trim();
}

const home = homedir();
const log = process.env.TOPICS_DB_SNAPSHOT_LOG ?? join(home, "Library", "Logs", `${LABEL}.log`);
const filled = readFileSync(TEMPLATE, "utf8")
  .replaceAll("__BUN__", bunPath())
  .replaceAll("__REPO__", REPO)
  .replaceAll("__HOME__", home)
  .replaceAll("__LOG__", log);

const left = filled.match(/__[A-Z]+__/g);
if (left) {
  console.error(`template still has placeholders: ${[...new Set(left)].join(", ")}`);
  process.exit(1);
}

if (process.argv.includes("--print")) {
  console.log(filled);
  process.exit(0);
}

const target = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
mkdirSync(join(home, "Library", "Logs"), { recursive: true });
writeFileSync(target, filled);

const userId = String(process.getuid?.() ?? 0);
// `bootout` first so a re-install replaces the loaded job instead of failing
// with "service already loaded"; it is allowed to fail on a first install.
try {
  execFileSync("/bin/launchctl", ["bootout", `gui/${userId}/${LABEL}`], { stdio: "ignore", env: process.env });
} catch {
  // not loaded yet: nothing to take out
}
execFileSync("/bin/launchctl", ["bootstrap", `gui/${userId}`, target], { stdio: "inherit", env: process.env });
console.log(`installed ${target}`);
console.log(`try it now: launchctl kickstart gui/${userId}/${LABEL}`);
