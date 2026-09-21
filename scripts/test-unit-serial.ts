#!/usr/bin/env bun
/**
 * THE SERIAL UNIT RUN, WITH THE SAME LOAD MEASUREMENT THE SHARDED ONE HAS.
 *
 * WHY IT EXISTS. `tests/helpers/time-slack.ts` widens the window of the tests
 * that wait for an event, and it reads the factor from `TOPICS_TEST_TIME_SLACK`
 * when a runner hands it down. Two runners do: the sharded unit run
 * (`scripts/test-unit-shards.ts`) and the e2e one. The SERIAL run - the one
 * `bun run test:unit` starts, used by the local bar and by CI - handed down
 * nothing, so every test file measured the load by itself at import time.
 *
 * That is not the same number, and the difference is not academic: measured on
 * 20/09, a full bar on a box at load 26 went red on exactly two tests out of
 * 16,991, both of them time-window tests, both green when run alone and green
 * when run as a pair straight after. A file imported 20 minutes into a 32
 * minute run reads the load of THAT moment - including the load the run itself
 * is making - while a file imported at second zero reads a quiet machine. Two
 * tests of the same suite end up with two different ideas of how slow the
 * machine is.
 *
 * WHAT IT CHANGES. The load is measured ONCE here, before bun starts, and
 * handed down. Same arithmetic as the sharded runner, same ceiling of 4x, so
 * the two runs agree. An explicit value in the env still wins: whoever forced
 * it knows something this script does not.
 *
 * WHAT IT DOES NOT CHANGE. The per-test timeout stays where it was
 * (`TOPICS_TEST_TIMEOUT_MS`, 30 s): this factor is for the windows a test waits
 * in, not for the limit that catches a hang. Widening that too would hide the
 * very hangs the limit exists to find.
 */
import { spawnSync } from "node:child_process";
import { cpus, loadavg } from "node:os";
import { TIME_SLACK_ENV, timeSlack, timeSlackNote } from "../shared/test-time-slack.ts";
import { SUITE_ROOTS } from "./test-unit-shards.ts";

/**
 * ONE list of roots, shared with the sharded runner. A second copy here would
 * be the drift that `test-unit-shards.cli.test.ts` exists to catch: the sharded
 * run compares its inventory against the serial one, and a root present in one
 * and missing from the other means a whole folder tested in only one of the two
 * ways. The `./` prefix is what `bun test` expects as a path.
 */
const PATHS = SUITE_ROOTS.map((root) => `./${root}`);

const load1 = loadavg()[0] ?? 0;
const cores = cpus().length || 1;
const slack = timeSlack({ load: load1, cores, forced: process.env[TIME_SLACK_ENV] });
if (slack > 1) console.error(`test-unit: ${timeSlackNote(slack, load1, cores)}`);

const timeout = process.env.TOPICS_TEST_TIMEOUT_MS ?? "30000";

/**
 * Explicit arguments REPLACE the default paths, they do not add to them: a
 * `test-unit-serial.ts <one file>` that also ran the whole suite would be a
 * trap for whoever is narrowing down a single test. A leading `-` is a flag,
 * so it is passed through and leaves the paths alone.
 */
const args = process.argv.slice(2);
const paths = args.filter((a) => !a.startsWith("-"));
const flags = args.filter((a) => a.startsWith("-"));
const targets = paths.length > 0 ? paths : PATHS;

const run = spawnSync(
  "bun",
  ["test", "--timeout", timeout, ...targets, ...flags],
  {
    stdio: "inherit",
    env: { ...process.env, [TIME_SLACK_ENV]: String(slack) },
  },
);

process.exit(run.status ?? 1);
