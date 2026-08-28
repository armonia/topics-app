/**
 * The soft timer must be suspended by a tool that WORKS, never by one that has
 * merely been announced.
 *
 * The defect: `armSoftTimer` read `trackedToolCallIds`, and an id enters that
 * list inside `onToolStart`, which fires at `content_block_start` - the moment
 * the model starts WRITING the call. From there the route believed it was
 * waiting on a tool while it was only listening to a stream, and the fastest
 * guard was off for the whole window (two minutes, measured on 2026-08-28).
 *
 * The other half of the pair matters just as much: a tool that really runs for
 * twelve minutes must keep suspending it. That is why the rule takes what the
 * provider can SAY as an input.
 * @covers CHAT-REL-03
 */
import { describe, expect, test } from "bun:test";
import { toolsSuspendSoftTimer } from "./soft-timer-suspension";

describe("toolsSuspendSoftTimer", () => {
  test("announced and never started: the timer stays armed (the defect)", () => {
    expect(toolsSuspendSoftTimer({
      announced: 1,
      executing: 0,
      providerSignalsExecStart: true,
    })).toBe(false);
  });

  test("running: suspended, for as long as it takes (the 12-minute build)", () => {
    expect(toolsSuspendSoftTimer({
      announced: 1,
      executing: 1,
      providerSignalsExecStart: true,
    })).toBe(true);
  });

  test("one running and three more announced: still suspended", () => {
    expect(toolsSuspendSoftTimer({
      announced: 4,
      executing: 1,
      providerSignalsExecStart: true,
    })).toBe(true);
  });

  test("nothing at all: nothing to suspend", () => {
    expect(toolsSuspendSoftTimer({
      announced: 0,
      executing: 0,
      providerSignalsExecStart: true,
    })).toBe(false);
    expect(toolsSuspendSoftTimer({
      announced: 0,
      executing: 0,
      providerSignalsExecStart: false,
    })).toBe(false);
  });

  test("a provider that cannot tell the two apart keeps the old meaning", () => {
    // A CLI executes the call itself and never says when: asking it for a
    // signal it cannot send would turn every long tool into a false
    // "the stream is slowing down". The announcement stays the evidence.
    expect(toolsSuspendSoftTimer({
      announced: 1,
      executing: 0,
      providerSignalsExecStart: false,
    })).toBe(true);
  });
});
