/**
 * The last output of a running tool, kept on the turn's registry entry for the
 * catch-up: capped like the native shell's buffer, dropped at the result.
 *
 * @covers CHAT-TOOL-11
 */
import { describe, expect, test } from "bun:test";
import { capLiveToolTail, forgetLiveToolTail, LIVE_TOOL_TAIL_BYTES, rememberLiveToolTail } from "./live-tool-tail";
import type { ActiveStream } from "../types";

describe("live tool tails", () => {
  test("each update replaces the tail; the result drops it", () => {
    const stream: Pick<ActiveStream, "liveToolTails"> = {};
    rememberLiveToolTail(stream, "t1", "r1");
    rememberLiveToolTail(stream, "t1", "r1\nr2");
    expect(stream.liveToolTails?.get("t1")).toBe("r1\nr2");
    forgetLiveToolTail(stream, "t1");
    expect(stream.liveToolTails?.has("t1")).toBe(false);
  });

  test("no registry entry: nothing to keep, nothing thrown", () => {
    expect(() => rememberLiveToolTail(undefined, "t1", "x")).not.toThrow();
    expect(() => forgetLiveToolTail(undefined, "t1")).not.toThrow();
  });

  test("the cap is in bytes and the cut starts on a whole character", () => {
    const line = "✓ passes ██████\n";
    const long = line.repeat(3_000);
    const capped = capLiveToolTail(long);
    expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(LIVE_TOOL_TAIL_BYTES);
    expect(capped.includes("�")).toBe(false);
    expect(long.endsWith(capped)).toBe(true);
    expect(capLiveToolTail("short")).toBe("short");
  });
});
