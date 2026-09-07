/**
 * THE WINDOW A TEST WAITS IN, WIDENED FOR THE MACHINE IT IS RUNNING ON.
 *
 * A test that waits for an event writes its window ONCE, sized for a quiet
 * machine, and passes it through `slackMs()`. On an idle box the number comes
 * back unchanged; under the fleet it is multiplied by the factor decided in
 * `shared/test-time-slack.ts`, which is where the reasoning lives.
 *
 * WHO DECIDES THE NUMBER. Whoever launched the run, if they said so: the shard
 * runner and the board's pre-review checks measure the load once and hand it
 * down in `TOPICS_TEST_TIME_SLACK`, so every shard of one round uses the SAME
 * factor instead of each file re-reading a load that moves under it. Without
 * that env - a hand typed `bun test <file>` - this measures the load itself.
 *
 * Read once per process, on purpose: a window computed at the top of a file and
 * a window computed halfway through it must be the same window.
 *
 * ONLY FOR TESTS. Nothing in production reads this: a product timer that grows
 * with the load is a different decision, and this is not it.
 */
import { cpus, loadavg } from "node:os";
import { TIME_SLACK_ENV, timeSlack } from "../../shared/test-time-slack";

/** The factor in force for this process. 1 on a quiet machine. */
export const TIME_SLACK = timeSlack({
  load: loadavg()[0] ?? 0,
  cores: cpus().length,
  forced: process.env[TIME_SLACK_ENV],
});

/** A window written for a quiet machine, in milliseconds for this one. */
export function slackMs(ms: number): number {
  return Math.round(ms * TIME_SLACK);
}
