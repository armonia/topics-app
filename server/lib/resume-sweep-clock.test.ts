/**
 * The resume sweep's two clocks under a Claude hold.
 *
 * A Claude hold walls the Claude chats, and the sweep defers those one by one
 * (`riprendiTurniInterrotti`). The clocks deferred the whole sweep instead, so
 * a Codex chat cut by the stale sweeper, under a notice promising it resumes
 * within minutes, stayed still for as long as the Claude API was down: and the
 * api-down hold opens on any 5xx retry of any claude-code child.
 *
 * @covers RESUME-04
 */
import { afterEach, expect, test } from "bun:test";
import { clearProviderHold, holdForApiDown, resetProviderHoldStore } from "./provider-hold";
import { createResumeSweepClock } from "./resume-sweep-clock";

const clocks: Array<{ stop(): void }> = [];
afterEach(() => {
  for (const c of clocks.splice(0)) c.stop();
  clearProviderHold();
  resetProviderHoldStore();
});

function counted() {
  let sweeps = 0;
  const clock = createResumeSweepClock(async () => { sweeps++; }, { periodMs: 10, nudgeMs: 10 });
  clocks.push(clock);
  return { clock, sweeps: () => sweeps };
}

const settle = () => new Promise((r) => setTimeout(r, 60));

test("under a Claude hold the nudge still runs the sweep, which defers the Claude chats itself", async () => {
  const { clock, sweeps } = counted();
  holdForApiDown();
  clock.nudge();
  await settle();
  expect(sweeps()).toBe(1);
});

test("under a Claude hold the periodic sweep still runs", async () => {
  const { clock, sweeps } = counted();
  holdForApiDown();
  clock.start();
  await settle();
  expect(sweeps()).toBeGreaterThan(0);
});
