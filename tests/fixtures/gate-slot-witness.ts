/**
 * A `bun test` run that says WHEN it was running, for the bench of the gate
 * semaphore.
 *
 * It is a fixture and not a test: nothing under `tests/fixtures` is in the
 * suite's path list, and it is launched by path from
 * `tests/unit/gate-covers-direct-bun-test.test.ts`.
 *
 * THE RENDEZVOUS IS THE POINT. Measuring "did the two runs overlap?" with two
 * fixed sleeps makes the answer depend on how fast bun starts, which under load
 * is exactly the variable that ruins the measurement: two runs that were never
 * throttled can miss each other simply because one started three seconds late,
 * and the bench would read that as a working brake. So each run announces
 * itself and then WAITS for a partner, up to a deadline. If the semaphore is
 * doing its job the partner cannot come and the wait times out; if it is not,
 * the two see each other and both end at once.
 *
 * AND THEN IT DWELLS, which is not decoration. Two unthrottled runs recognise
 * each other in UNDER A MILLISECOND, so both windows collapse onto the same
 * instant and the overlap computes as exactly zero: the bench would read a real
 * overlap as no overlap and call the brake working. Measured, first run of this
 * file: four events, one millisecond apart end to end. Holding for a fixed
 * moment after the rendezvous gives the window a width the clock can see, and
 * costs the throttled case the same moment, where it changes nothing.
 *
 * Env: TOPICS_GATE_WITNESS       file to append `start|end <pid> <ms>` to
 *      TOPICS_GATE_WITNESS_WAIT  how long to wait for a partner (default 4s)
 *      TOPICS_GATE_WITNESS_DWELL how long to hold before ending (default 300ms)
 * With no witness file it is an ordinary passing test, which is what the junit
 * bench needs of it.
 */
import { test, expect } from "bun:test";
import { appendFileSync, readFileSync } from "node:fs";

const WITNESS = process.env.TOPICS_GATE_WITNESS;
const WAIT_MS = Number(process.env.TOPICS_GATE_WITNESS_WAIT ?? 4000);
const DWELL_MS = Number(process.env.TOPICS_GATE_WITNESS_DWELL ?? 300);

test("the witness records its own window", () => {
  if (!WITNESS) {
    expect(1).toBe(1);
    return;
  }
  appendFileSync(WITNESS, `start ${process.pid} ${Date.now()}\n`);
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const starts = readFileSync(WITNESS, "utf8").split("\n").filter((l) => l.startsWith("start")).length;
    if (starts >= 2) break;
    Bun.sleepSync(50);
  }
  Bun.sleepSync(DWELL_MS);
  appendFileSync(WITNESS, `end ${process.pid} ${Date.now()}\n`);
}, 120_000);
