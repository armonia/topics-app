/**
 * The window that sent the message reads its tool rows off its own SSE: the
 * same fields as the WS frame, or no clock, no duration and no reason.
 *
 * @covers CHAT-TOOL-10
 */
import { describe, expect, test } from "bun:test";
import { toolCallFromSse, withSseToolResult } from "./sseToolFrames";
import type { ToolCall } from "../types";

const newId = () => "generated";

describe("toolCallFromSse", () => {
  test("the announcement keeps startedAt, detail and status", () => {
    const tc = toolCallFromSse({
      id: "toolu_1", function: { name: "Bash", arguments: JSON.stringify({ command: "sleep 30" }) }, contentOffset: 4,
      status: "running", startedAt: 1_000, detail: { type: "shell", command: "sleep 30" },
    }, newId);
    expect(tc).toEqual({
      id: "toolu_1", name: "Bash", args: { command: "sleep 30" }, status: "running", contentOffset: 4,
      startedAt: 1_000, detail: { type: "shell", command: "sleep 30" },
    });
  });

  test("an older server's entry still makes a running row", () => {
    expect(toolCallFromSse({ function: { name: "Read" } }, newId)).toEqual({ id: "generated", name: "Read", args: {}, status: "running", contentOffset: undefined });
  });

  test("an entry with no tool name makes no row", () => {
    expect(toolCallFromSse({ id: "x" }, newId)).toBeNull();
  });
});

describe("withSseToolResult", () => {
  const running: ToolCall = { id: "toolu_1", name: "Bash", args: { command: "sleep 30" }, status: "running", startedAt: 1_000 };

  test("the result carries endedAt, error and detail onto a new object", () => {
    const next = withSseToolResult(running, {
      id: "toolu_1", status: "error", result: "", error: "Stream ended with error", endedAt: 4_000,
      detail: { type: "shell", command: "sleep 30" },
    });
    expect(next).not.toBe(running);
    expect(next).toMatchObject({ status: "error", error: "Stream ended with error", endedAt: 4_000, startedAt: 1_000, detail: { type: "shell", command: "sleep 30" } });
  });

  test("fields the frame does not carry keep what the row had", () => {
    const next = withSseToolResult({ ...running, error: "before", endedAt: 2_000, detail: { type: "shell", command: "x" } }, { id: "toolu_1", result: "ok" });
    expect(next).toMatchObject({ status: "success", result: "ok", error: "before", endedAt: 2_000, detail: { type: "shell", command: "x" } });
  });
});
