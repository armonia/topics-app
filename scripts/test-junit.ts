#!/usr/bin/env bun
/**
 * THE UNIT SUITE WITH A JUNIT REPORT, ON A PATH THAT BELONGS TO THIS RUN.
 *
 * WHY IT EXISTS. Measured on 2026-08-27 at 02:40: two full `bun test` runs
 * alive at once from the same worktree, both writing
 * `--reporter-outfile=/tmp/unit.xml`. That path appears nowhere in this
 * repository - whoever needed a machine-readable result wrote the command by
 * hand and invented a name for the file. Two runs, one file: the second
 * overwrites the first, and whoever reads it can be reading a verdict that
 * belongs to another run, in either direction (a red taken for green or a green
 * taken for red).
 *
 * A shared fixed path under /tmp is a shape this repo has already paid for -
 * `tests/unit/no-shared-tmp-paths.test.ts` exists because of it. The cure is
 * the same one: the path is DERIVED, per run, so two runs cannot meet.
 *
 * WHY IT READS package.json INSTEAD OF SPELLING THE COMMAND OUT. The suite's
 * path list and its `--timeout` live in the `test:unit` script, and a guard
 * (`tests/unit/test-default-timeout.test.ts`) watches that script. Copying them
 * here would create a second copy that nothing watches, and it would drift the
 * first time somebody adds a directory to the suite. So this reads the real
 * script and only adds the two reporter flags.
 *
 *   bun run test:unit:junit                     # the whole suite
 *   bun run test:unit:junit ./tests/unit/x.ts   # a subset, same report
 *   bun run test:unit:junit --dry-run           # print path and command, run nothing
 *
 * The last line of the output is the file's path, so a caller can pick it up
 * without guessing.
 *
 * WHY THE DRY RUN EXISTS. It is how you see WHERE the report will land and WHAT
 * will be run before spending twenty minutes on it. It is also how the bench
 * measures two concurrent runs without nesting a whole suite inside the suite:
 * the first version of that test did nest one, took 89 seconds, and failed on a
 * stray async error belonging to another test file entirely. A bench that long
 * measures the machine, not the thing.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/**
 * The report of THIS run, and of no other.
 *
 * Three pieces, each closing a different collision: the worktree name (two
 * checkouts of the same project on one machine), the pid (two runs from the
 * same worktree, which is what was measured), and the timestamp (the same pid
 * reused later, and it makes the directory readable by age). It stays inside
 * the worktree under `test-results/`, which is already git-ignored, instead of
 * a shared /tmp.
 */
export function junitOutfilePath(root: string, pid: number, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return join(root, "test-results", "junit", `unit-${basename(root)}-${pid}-${stamp}.xml`);
}

/** The command inside `test:unit`, i.e. what the semaphore wrapper wraps. */
export function innerTestCommand(script: string): string {
  const m = /--\s+'([^']+)'\s*$/.exec(script.trim());
  return m ? m[1] : script;
}

/**
 * The same command with the junit reporter bolted on, and with the suite's own
 * path list replaced when the caller named some files. The paths are the
 * trailing `./...` tokens: replacing them keeps the timeout knob and any other
 * flag exactly as `test:unit` has them.
 */
export function junitCommand(script: string, outfile: string, paths: string[]): string {
  let cmd = innerTestCommand(script);
  if (paths.length > 0) cmd = cmd.replace(/(\s+\.\/\S+)+\s*$/, "") + " " + paths.join(" ");
  return cmd.replace("bun test", `bun test --reporter=junit --reporter-outfile=${outfile}`);
}

if (import.meta.main) {
  const pkg = await Bun.file(join(ROOT, "package.json")).json();
  const script = pkg.scripts?.["test:unit"];
  if (typeof script !== "string") {
    console.error("test-junit: package.json has no `test:unit` script to derive the command from.");
    process.exit(2);
  }
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const paths = argv.filter((a) => a !== "--dry-run");

  const outfile = junitOutfilePath(ROOT, process.pid, new Date());
  const cmd = junitCommand(script, outfile, paths);
  if (dryRun) {
    console.error(cmd);
    console.log(outfile);
    process.exit(0);
  }
  mkdirSync(join(ROOT, "test-results", "junit"), { recursive: true });

  // Through the wrapper, like `test:unit`: this run counts against the same
  // machine-wide slot and inherits the same wall-clock cap. Asking for a report
  // must not be a way around the semaphore.
  const child = spawn("bun", ["run", join(ROOT, "scripts", "slot.ts"), "test:unit:junit", "--", cmd], {
    cwd: ROOT,
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    console.log(outfile);
    process.exit(signal ? 1 : (code ?? 0));
  });
}
