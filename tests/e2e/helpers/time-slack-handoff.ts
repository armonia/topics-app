/**
 * ONE TIME FACTOR FOR THE WHOLE E2E RUN, DECIDED ONCE AND HANDED DOWN.
 *
 * The e2e suite is the only one of the three that never got this. The unit
 * shards (`scripts/test-unit-shards.ts`) and the board's pre-review checks
 * (`server/services/review-checks.ts`) both measure the load once and pass it
 * in `TOPICS_TEST_TIME_SLACK`, so every shard of one round shares a number
 * instead of each file re-reading a load that moves under it. Playwright gets
 * it for free: its workers are forked from the runner process, so an env
 * written in `globalSetup` is the env `tests/helpers/time-slack.ts` reads in
 * each of them (verified 2026-09-12: runner x3.0, worker `TIME_SLACK=3`).
 *
 * WHEN TO CALL IT: at the END of `globalSetup`, not at the top. The load a spec
 * meets is not the load of a runner that just booted. By the end of setup the
 * job has installed deps, built, downloaded Chromium, started the test server
 * and seeded it — the one-minute average finally describes the machine the
 * tests are about to run on. Measuring at process start is what made this look
 * pointless: a fresh CI runner reads ~0, the factor comes out 1, and the patch
 * is one that never engages.
 *
 * It lives in its own file so it can be TESTED as a function instead of as a
 * shape grepped out of `global-setup.ts`.
 */
import { cpus, loadavg } from "node:os";
import { TIME_SLACK_ENV, timeSlack, timeSlackNote } from "../../../shared/test-time-slack";

export interface TimeSlackHandoff {
  slack: number;
  /** The line to print. Always printed, even at x1.0 — see below. */
  note: string;
}

/**
 * Measure the machine, write the factor into `env`, and return the line to say.
 *
 * REPORTED EVEN AT x1.0, unlike the unit shards, which only speak above 1. The
 * number IS the measurement here: a CI log that reads «x1.0, load 0.4/4»
 * settles whether the lever engaged on that runner, and without it every wait
 * in every spec has to be argued about from a distance.
 *
 * `env` is a parameter so a test can watch it being written without touching
 * the process it is running in.
 */
export function handDownTimeSlack(
  env: Record<string, string | undefined> = process.env,
  machine: { load: number; cores: number } = { load: loadavg()[0] ?? 0, cores: cpus().length || 1 },
): TimeSlackHandoff {
  const slack = timeSlack({ load: machine.load, cores: machine.cores, forced: env[TIME_SLACK_ENV] });
  env[TIME_SLACK_ENV] = String(slack);
  return { slack, note: timeSlackNote(slack, machine.load, machine.cores) };
}
