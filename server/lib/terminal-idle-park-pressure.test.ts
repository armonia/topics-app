/**
 * @covers RUNTIME-06
 *
 * AT THE CEILING AN IDLE SESSION COSTS SWAP, NOT JUST RAM.
 *
 * The normal parking threshold is tuned for comfort: a parked session shows the
 * «Sessione scaduta» overlay until the pane revives it, so we wait a long time. // allow-italian: the overlay's own Italian label
 * That arithmetic changes when memory runs out, and only then.
 *
 * MEASURED on 2026-09-18 on the live server: two chat CLIs idle for 9h45, zero
 * topics streaming, 232 and 229 MB plus their child MCP servers. 452 MB for
 * sessions doing nothing, on a 16 GB Mac sitting at 45 GB of swap that day.
 *
 * WHAT PRESSURE DOES NOT CHANGE MATTERS MORE THAN WHAT IT DOES. The ceiling
 * tightens ONE threshold; every guard in `decidePark` stays intact, and that is
 * what these tests hold still: a turn in flight, a PTY writing now, somebody
 * watching, a missing transcript stay refusals while the machine drowns. The
 * rule at the top of terminal-idle-park.ts still stands: failing to park costs
 * RAM, the opposite failure costs somebody's work.
 */
import { describe, expect, test } from "bun:test";
import { decidePark, thresholdUnderPressure, type ParkCandidate } from "./terminal-idle-park";

const NORMAL_MS = 30 * 60_000;

describe("the threshold when the machine is at the ceiling", () => {
  test("with no pressure it stays the normal one", () => {
    expect(thresholdUnderPressure(NORMAL_MS, { atCeiling: false })).toBe(NORMAL_MS);
  });

  test("at the ceiling it tightens to a quarter", () => {
    expect(thresholdUnderPressure(NORMAL_MS, { atCeiling: true })).toBe(NORMAL_MS / 4);
  });

  test("signal ABSENT = normal threshold, not the tight one", () => {
    // The rule written at the top of the module: with no data we do not park
    // FASTER. A probe that does not answer is not a ceiling, and treating it as
    // one would make the reaper more aggressive exactly when we know nothing.
    expect(thresholdUnderPressure(NORMAL_MS, null)).toBe(NORMAL_MS);
  });

  test("the one-minute floor holds even on an already low threshold", () => {
    // Without the floor, a 2-minute threshold would become 30 seconds at the
    // ceiling: that parks a session between two commands, which is exactly what
    // the minimum in `idleParkThresholdMs` exists to prevent.
    expect(thresholdUnderPressure(2 * 60_000, { atCeiling: true })).toBe(60_000);
  });
});

/** A parkable candidate: idle for an hour, nobody watching. */
const dormant = (over: Partial<ParkCandidate> = {}): ParkCandidate => ({
  id: "t1",
  type: "claude-code",
  claudeSessionId: "abc",
  busy: false,
  idleMs: 60 * 60_000,
  attachedClients: 0,
  hasTranscript: true,
  phase: "awaiting-user",
  ...over,
});

describe("the ceiling tightens the threshold, not the guards", () => {
  const tight = thresholdUnderPressure(NORMAL_MS, { atCeiling: true });

  test("a genuinely idle session is parked", () => {
    expect(decidePark(dormant(), tight)).toEqual({ park: true });
  });

  test("idle for 10 minutes: no at the normal threshold, YES at the tight one", () => {
    // The card in one line: same candidate, two verdicts, and what decides is
    // the state of the machine.
    const c = dormant({ idleMs: 10 * 60_000 });
    expect(decidePark(c, NORMAL_MS)).toEqual({ park: false, reason: "too-recent" });
    expect(decidePark(c, tight)).toEqual({ park: true });
  });

  test("a turn in flight is NOT parked, however hard the machine drowns", () => {
    expect(decidePark(dormant({ phase: "running" }), tight)).toEqual({ park: false, reason: "phase-active" });
  });

  test("a PTY writing right now is NOT parked", () => {
    expect(decidePark(dormant({ busy: true }), tight)).toEqual({ park: false, reason: "busy" });
  });

  test("a session somebody is watching is NOT parked", () => {
    expect(decidePark(dormant({ attachedClients: 1 }), tight)).toEqual({ park: false, reason: "watched" });
  });

  test("with no transcript it is NOT parked: it would never come back", () => {
    expect(decidePark(dormant({ hasTranscript: false }), tight)).toEqual({ park: false, reason: "no-transcript" });
  });

  test("one waiting for a human answer is NOT parked", () => {
    // `awaiting-approval` is a person who owes an answer, not an abandoned
    // session: parking it throws the question away.
    expect(decidePark(dormant({ phase: "awaiting-approval" }), tight)).toEqual({ park: false, reason: "phase-active" });
  });

  test("a frozen tree is NOT parked, not even at the ceiling", () => {
    // The freeze is Topics deliberately holding that tree still. Killing the
    // CLI now would strand its processes STOPped forever.
    expect(decidePark(dormant({ hasFrozenTree: true }), tight)).toEqual({ park: false, reason: "frozen-tree" });
  });

  test("unmeasured idleness is NOT parked", () => {
    expect(decidePark(dormant({ idleMs: null }), tight)).toEqual({ park: false, reason: "idle-unknown" });
  });
});
