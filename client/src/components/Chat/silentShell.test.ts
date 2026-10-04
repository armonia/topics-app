/**
 * A running shell with no output says for how long, and counts down an opening `sleep`.
 *
 * @covers CHAT-TOOL-13
 */
import { describe, expect, test } from "bun:test";
import { formatTimeLeft, leadingSleepMs, sleepLeftMs } from "./silentShell";

describe("leadingSleepMs", () => {
  test("only a sleep that opens the command counts", () => {
    expect(leadingSleepMs("sleep 30; echo ok")).toBe(30_000);
    expect(leadingSleepMs("sleep 2m")).toBe(120_000);
    expect(leadingSleepMs("  sleep 1.5 && grep x log")).toBe(1_500);
    expect(leadingSleepMs("sleep 119\ngrep -c ok out.txt")).toBe(119_000);
    expect(leadingSleepMs("sleep 1h")).toBe(3_600_000);
    expect(leadingSleepMs("make && sleep 5")).toBeUndefined();
    expect(leadingSleepMs("sleepy 3")).toBeUndefined();
    expect(leadingSleepMs("sleep $N")).toBeUndefined();
    expect(leadingSleepMs("sleep 30x")).toBeUndefined();
    expect(leadingSleepMs(undefined)).toBeUndefined();
  });
});

describe("sleepLeftMs and formatTimeLeft", () => {
  test("what is left of the wait, rounded up to the second", () => {
    expect(sleepLeftMs("sleep 30; echo ok", 11_200)).toBe(18_800);
    expect(formatTimeLeft(18_800)).toBe("19s");
    expect(formatTimeLeft(125_000)).toBe("2m 05s");
  });

  test("a wait that is over, or none, leaves no countdown", () => {
    expect(sleepLeftMs("sleep 3", 3_000)).toBeUndefined();
    expect(sleepLeftMs("bun test", 1_000)).toBeUndefined();
  });
});
