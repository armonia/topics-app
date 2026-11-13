import { describe, expect, test } from "bun:test";
import { foregroundToolHold, FOREGROUND_TOOL_HOLD_MS } from "./stale-stream-sweep";

describe("foregroundToolHold", () => {
  const now = 10_000_000;
  const running = (startedAt?: number) => [{ status: "running", ...(startedAt === undefined ? {} : { startedAt }) }];
  test("a young running tool holds", () => {
    expect(foregroundToolHold({ toolCalls: running(now - 10 * 60_000) }, now)).toBe(true);
  });
  test("a tool past the cap no longer holds", () => {
    expect(foregroundToolHold({ toolCalls: running(now - FOREGROUND_TOOL_HOLD_MS - 1) }, now)).toBe(false);
  });
  test("a running tool without a stamp holds (doubt never kills)", () => {
    expect(foregroundToolHold({ blocks: [{ kind: "tool", toolCall: { status: "running" } }] }, now)).toBe(true);
  });
  test("no running tool, or no row, does not hold", () => {
    expect(foregroundToolHold({ toolCalls: [{ status: "done", startedAt: now }] }, now)).toBe(false);
    expect(foregroundToolHold(null, now)).toBe(false);
  });
});
