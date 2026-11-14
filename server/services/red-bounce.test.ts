/** @covers LAND-15 */
import { describe, expect, test } from "bun:test";
import { MAX_AUTO_BOUNCES, RED_BOUNCE_NOTE, bouncesSinceHuman, redBounceMessage, redBounceVerdict } from "./red-bounce";

const red = { status: "review", checksState: "fail", checksCommit: "502cba06aa", deliveryCommit: "502cba06aa11" };
const note = (round: number) => ({ author: "system", kind: "service", content: `${RED_BOUNCE_NOTE} (giro ${round})` });

describe("redBounceVerdict", () => {
  test("a red review card on its delivered commit goes back to the agent", () => {
    expect(redBounceVerdict(red, [], { turnLive: false })).toEqual({ bounce: true, round: 1 });
  });

  test("green, unmeasured, running or another status never bounce", () => {
    for (const checksState of ["pass", "unknown", "running", null]) {
      expect(redBounceVerdict({ ...red, checksState }, [], { turnLive: false }).bounce).toBe(false);
    }
    expect(redBounceVerdict({ ...red, status: "in_progress" }, [], { turnLive: false }).bounce).toBe(false);
    expect(redBounceVerdict({ ...red, archived: true }, [], { turnLive: false }).bounce).toBe(false);
  });

  test("a red measured on another commit is history, not a verdict", () => {
    expect(redBounceVerdict({ ...red, checksCommit: "aaaaaaa1" }, [], { turnLive: false }).bounce).toBe(false);
    expect(redBounceVerdict({ ...red, checksCommit: null }, [], { turnLive: false }).bounce).toBe(false);
  });

  test("an open agent turn is not interrupted", () => {
    expect(redBounceVerdict(red, [], { turnLive: true }).bounce).toBe(false);
  });

  test("after the cap the card waits for a person, and a person's word resets the count", () => {
    const three = [note(1), note(2), note(3)];
    const v = redBounceVerdict(red, three, { turnLive: false });
    expect(v).toMatchObject({ bounce: false, exhausted: true });
    const afterHuman = [...three, { author: "user", kind: "comment", content: "prova così" }];
    expect(redBounceVerdict(red, afterHuman, { turnLive: false })).toEqual({ bounce: true, round: 1 });
    expect(bouncesSinceHuman(three)).toBe(MAX_AUTO_BOUNCES);
  });

  test("the message carries the round and the failing output", () => {
    const m = redBounceMessage(2, "**Checks pre-review ROSSI**: `gates:fast` exit 1.");
    expect(m.startsWith(RED_BOUNCE_NOTE)).toBe(true);
    expect(m).toContain("giro 2 di 3");
    expect(m).toContain("gates:fast");
  });
});
