/**
 * A chat that waits on its own `spawn_agent` child is not idle: the child's
 * result wakes it. On 04/10 topic:d740f8ae got an «Objective still open» every
 * ~2 minutes while `anim-fix` worked: 12 turns out of 16 wasted, $37.
 *
 * @covers SUBAGENT-12
 */
import { describe, expect, test } from "bun:test";
import { backgroundOfTurn } from "./goal-continuation";

const idleProvider = { backgroundState: () => "none" };

describe("backgroundOfTurn, sub-agents", () => {
  test("a child still working is background work: the goal waits, it does not nudge", () => {
    expect(backgroundOfTurn(idleProvider, "topic:x", "none", "running")).toEqual({ backgroundWork: true, backgroundWakeOnly: false });
  });

  test("a child done with only its result to deliver is a wake on its way", () => {
    expect(backgroundOfTurn(idleProvider, "topic:x", "none", "wake-queued")).toEqual({ backgroundWork: true, backgroundWakeOnly: true });
  });

  test("a running command beside a delivered child result still counts as running", () => {
    expect(backgroundOfTurn(idleProvider, "topic:x", "running", "wake-queued").backgroundWakeOnly).toBe(false);
  });

  test("no child, no command, nothing in the CLI: the turn is judged as before", () => {
    expect(backgroundOfTurn(idleProvider, "topic:x")).toEqual({ backgroundWork: false, backgroundWakeOnly: false });
  });
});
