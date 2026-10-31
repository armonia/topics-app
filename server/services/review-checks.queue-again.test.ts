/**
 * A CHECK WHOSE `slot.ts` QUEUES AGAIN AFTER A FREEZE (card cda99908): the
 * clock stops and resumes on the lines that carry the run's token, never on a
 * line the command prints, and a `slot.ts` dead in that queue does not leave
 * the check open behind its stopped command.
 *
 * Out of `review-checks.test.ts`, which this would push past the size rail;
 * the windows are ratios stretched by the same factor, as there.
 *
 * @covers KANBAN-15
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { slotAcquiredLine, slotQueuedAgainLine } from "../../shared/slot-acquired";
import { slackMs } from "../../tests/helpers/time-slack";
import { psStates } from "../../scripts/gate-slot";
import { runReviewChecks } from "./review-checks";

const stretched = (ms: number): number => slackMs(ms);
/** The same window as the argument of `sleep`, in seconds. */
const sleepFor = (ms: number): string => (stretched(ms) / 1000).toFixed(2);
/** A run token as `slot.ts` prints it, and the script itself. */
const RUN = "0a1b2c3d4e5f";
const SLOT_SCRIPT = join(import.meta.dir, "../../scripts/slot.ts");

describe("runReviewChecks, a second queue after a freeze", () => {
  let cwd = "";
  beforeAll(() => { cwd = mkdtempSync(join(tmpdir(), "review-checks-queue-again-")); });
  afterAll(() => { rmSync(cwd, { recursive: true, force: true }); });

  test.concurrent("a second queue after a freeze stops the clock again, and resumes it where it was (card cda99908)", async () => {
    // `slot.ts` continued after a freeze whose place was taken queues again and
    // prints the two lines once more. 0.3 s of work, 1.5 s queued again, 0.3 s
    // of work, against a 1 s cap: without the second pair the cap kills it in
    // the queue (review of 31/10).
    const waiting = slotQueuedAgainLine("typecheck", RUN, "$$", "$$");
    const acquired = slotAcquiredLine("typecheck", 0, RUN);
    const runs = await runReviewChecks(
      [{ name: "ricongelato", cmd: `echo '${acquired}' 1>&2; sleep ${sleepFor(300)}; echo "${waiting}" 1>&2; sleep ${sleepFor(1500)}; echo '${acquired}' 1>&2; sleep ${sleepFor(300)}` }],
      { cwd, timeoutMs: stretched(1000) },
    );
    expect(runs[0].timedOut).toBe(false);
    expect(runs[0].ok).toBe(true);
  }, 20_000);

  test.concurrent("the second acquired line resumes the clock, it does not hand out a fresh cap (control)", async () => {
    // 0.7 s of work, a short second queue, 0.7 s of work: 1.4 s of command
    // against a 1 s cap is a timeout, as without any queue.
    const waiting = slotQueuedAgainLine("typecheck", RUN, "$$", "$$");
    const acquired = slotAcquiredLine("typecheck", 0, RUN);
    const runs = await runReviewChecks(
      [{ name: "ricongelato lungo", cmd: `echo '${acquired}' 1>&2; sleep ${sleepFor(700)}; echo "${waiting}" 1>&2; sleep 0.1; echo '${acquired}' 1>&2; sleep ${sleepFor(700)}` }],
      { cwd, timeoutMs: stretched(1000) },
    );
    expect(runs[0].timedOut).toBe(true);
  }, 20_000);

  test.concurrent("a command printing a waiting line of its own does not stop its deadline (review of 31/10, fourth round)", async () => {
    // The real `slot.ts`, its own counter (set in the command: the round does
    // not pass an env through): the line the command prints carries no token
    // of the run, so the cap still ends a command that hangs after it.
    const slots = mkdtempSync(join(tmpdir(), "topics-review-slots-"));
    try {
      const runs = await runReviewChecks(
        [{ name: "finta coda", cmd: `TOPICS_GATE_SLOTS=1 TOPICS_GATE_SLOT_DIR=${slots} bun run ${SLOT_SCRIPT} gx -- "echo '[slot] waiting nested: x' 1>&2; sleep 20"` }],
        { cwd, timeoutMs: stretched(1500) },
      );
      expect(runs[0].timedOut).toBe(true);
      expect(runs[0].ms).toBeLessThan(15_000);
    } finally {
      rmSync(slots, { recursive: true, force: true });
    }
  }, 30_000);

  test.concurrent("slot.ts dead in its second queue: the stopped command is ended, the check returns (review of 31/10, fourth round)", async () => {
    // No SIGSTOP: the "stopped command" is a sleep in a group of its own (a
    // detached spawn) that keeps stderr open, and the "slot.ts" a sleep that
    // ends in 0.5 s. Then the shell dies by SIGKILL, as in the reproduction.
    // Before: the deadline was off and the check waited the orphan's 30 s.
    const groupFile = join(cwd, `orphan-${Date.now()}`);
    const spawner = join(cwd, `orphan-${Date.now()}.ts`);
    writeFileSync(spawner, `const c = require("node:child_process").spawn("sleep", ["30"], { detached: true, stdio: ["ignore", "ignore", "inherit"] }); c.unref(); console.log(c.pid);`);
    const acquired = slotAcquiredLine("typecheck", 0, RUN);
    const waiting = slotQueuedAgainLine("typecheck", RUN, "$P", "$G");
    const started = Date.now();
    let group = 0;
    try {
      const runs = await runReviewChecks(
        [{ name: "orfano", cmd: `echo '${acquired}' 1>&2; G=$(${process.execPath} ${spawner}); sleep 0.5 & P=$!; echo $G > ${groupFile}; echo "${waiting}" 1>&2; kill -KILL $$` }],
        { cwd, timeoutMs: stretched(1500) },
      );
      group = Number(readFileSync(groupFile, "utf8").trim());
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(runs[0].ok).toBe(false);
      // The orphan is dead, not merely let go of (a zombie until reaped: dead).
      expect(psStates([group]).get(group) ?? "Z").toStartWith("Z");
    } finally {
      if (group > 1) try { process.kill(-group, "SIGKILL"); } catch { /* gone */ }
    }
  }, 30_000);
});
