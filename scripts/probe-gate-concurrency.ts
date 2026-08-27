#!/usr/bin/env bun
/**
 * HOW MANY `bun test` RUNS ARE ALIVE ON THIS MACHINE RIGHT NOW, against how
 * many the semaphore declares.
 *
 *   bun run probe:gate-slots
 *
 * WHY A REPORT AND NOT A GATE. The number it reads is the STATE OF THE
 * MACHINE - other people's agents, a suite somebody left running in a terminal,
 * a nightly. A check that goes red because of a run in another checkout is not
 * a gate, it is a report, and the `probe:` prefix is where this repository
 * writes that distinction down (`tests/unit/check-scripts-are-wired.test.ts`).
 *
 * WHAT IT IS FOR. It is the control measure of the semaphore: with N agents
 * working, the number of simultaneous `bun test` runs must not exceed the slots
 * `gate-slot.ts` declares. On 2026-08-27 at 02:40 this machine had TWO, from
 * one worktree, with the board declaring a cap of one agent - which is the
 * measurement this whole change comes from. Run it while the board is busy: the
 * verdict is one line, and the exit code is non-zero when the count is over the
 * declared slots, so it can be read from a script.
 *
 * WHAT IT COUNTS. Only the runner processes: argv0 is `bun` and the first
 * argument is `test`. The wrapper (`bun run scripts/slot.ts ...`) and the shell
 * it spawns are not runs, they are the queue in front of one, and counting them
 * would double every number.
 */
import { slotCount, slotDir } from "./gate-slot.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Run {
  pid: number;
  /** Elapsed wall clock as `ps` prints it: `[[dd-]hh:]mm:ss`. */
  elapsed: string;
  command: string;
}

/** argv0 is a `bun`, and its first argument is `test`. Nothing else counts. */
export function isBunTestRun(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  if (tokens.length < 2) return false;
  const argv0 = tokens[0].split("/").pop() ?? "";
  if (argv0 !== "bun" && argv0 !== "bun-debug") return false;
  // Runtime flags may sit between the two (`bun --bun test`), but a subcommand
  // that is not `test` (`bun run`, `bun x`) is not a run of the suite.
  const first = tokens.slice(1).find((t) => !t.startsWith("-"));
  return first === "test";
}

export function parsePs(output: string): Run[] {
  const runs: Run[] = [];
  for (const line of output.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pid, elapsed, command] = m;
    if (!isBunTestRun(command)) continue;
    runs.push({ pid: Number(pid), elapsed, command });
  }
  return runs;
}

function liveRuns(): Run[] {
  const r = Bun.spawnSync(["ps", "-axo", "pid=,etime=,command="]);
  return parsePs(new TextDecoder().decode(r.stdout)).filter((run) => run.pid !== process.pid);
}

/** The slot files that are actually held, so the two numbers can be compared. */
function heldSlots(): number {
  const dir = slotDir();
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((n) => /^\d+\.pid$/.test(n)).length;
}

if (import.meta.main) {
  const slots = slotCount();
  const runs = liveRuns();
  console.log(`[probe] gate slots declared: ${slots === 0 ? "0 (throttle off)" : slots}`);
  console.log(`[probe] slot files held:     ${heldSlots()} in ${slotDir()}`);
  console.log(`[probe] live \`bun test\` runs: ${runs.length}`);
  for (const run of runs) {
    // The worktree is the useful half of the command: two runs from the SAME
    // one is the shape that was measured.
    const paths = run.command.match(/\.\/\S+/g);
    console.log(`  pid ${run.pid}  up ${run.elapsed}  ${paths ? paths.slice(0, 3).join(" ") : run.command.slice(0, 80)}`);
    const cwd = Bun.spawnSync(["lsof", "-a", "-p", String(run.pid), "-d", "cwd", "-Fn"]);
    const dir = new TextDecoder().decode(cwd.stdout).split("\n").find((l) => l.startsWith("n"));
    if (dir) console.log(`         cwd ${dir.slice(1)}`);
  }
  if (slots > 0 && runs.length > slots) {
    console.error(`[probe] OVER: ${runs.length} simultaneous runs against ${slots} declared slots.`);
    process.exit(1);
  }
  console.log("[probe] within the declared slots.");
}

