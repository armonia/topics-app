/**
 * The watchdog subshell of a scheduled command's wrapper must take its `sleep`
 * with it when TERM lands right after the fork: a `sleep` left in the group
 * keeps the leader's drain waiting until the time limit, and the exit code of
 * a command that ended in milliseconds is never written. Needs a POSIX shell.
 *
 * @covers SCHED-04
 */
import { describe, expect, test } from "bun:test";
import { execSync, spawnSync } from "node:child_process";
import { hasCommandShell, WATCHDOG_TERM_HANDLER } from "./command-process";

const real = test.skipIf(!hasCommandShell());

/** Pids of the processes whose command line holds `needle`, the probe itself excluded. */
const pidsRunning = (needle: string) =>
  execSync("ps -eo pid=,args=", { encoding: "utf8" }).split("\n")
    .filter((line) => line.includes(needle) && !line.includes("ps -eo"))
    .map((line) => Number(line.trim().split(/\s+/)[0]));

describe("watchdog TERM handler", () => {
  real("TERM between the fork of the sleep and the assignment of its pid leaves no sleep behind", () => {
    const seconds = 3000 + Math.floor(Math.random() * 500);
    // The subshell signals itself right after the fork: the trap runs before `_topics_sleep=$!`, the window of the race.
    const script = `( trap '${WATCHDOG_TERM_HANDLER}' TERM; sleep ${seconds} & kill -TERM "$(sh -c 'echo $PPID')"; _topics_sleep=$!; wait "$_topics_sleep" )`;
    try {
      spawnSync("/bin/sh", ["-c", script], { stdio: "ignore", timeout: 10_000 });
      expect(pidsRunning(`sleep ${seconds}`)).toEqual([]);
    } finally {
      for (const pid of pidsRunning(`sleep ${seconds}`)) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    }
  });
});
