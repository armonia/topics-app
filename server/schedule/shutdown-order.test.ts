/**
 * R3: the engine's timer is the first thing the shutdown stops, so no job starts
 * while the server is going down. Read on the source, like the other boot checks.
 *
 * @covers SCHED-04
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("gracefulShutdown stops the schedule engine before any other timer", () => {
  const source = readFileSync(join(import.meta.dir, "../boot/timers-shutdown.ts"), "utf8");
  const body = source.slice(source.indexOf("async function gracefulShutdown"));
  const stop = body.indexOf("scheduleEngine.stop()");
  expect(stop).toBeGreaterThan(-1);
  expect(stop).toBeLessThan(body.indexOf("clearInterval("));
});
