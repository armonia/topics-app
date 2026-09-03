/**
 * The log line of an API request: when it exists and what it says.
 *
 * The measured defect: the log had a START line per request (no time, no
 * outcome, no duration) and a completion line for 404s only; 44% of those
 * lines were the 2s viewer poll. Pinned here is the opposite: one line on
 * COMPLETION with time, status and duration, and the routes that fire on a
 * clock staying quiet until they fail or slow down.
 *
 * @covers HTTP-LOG-01
 */
import { describe, expect, test } from "bun:test";
import { SLOW_MS, formatHttpLine, httpLogLine, isQuietRoute, shouldLogHttp } from "./http-log";

const NOW = new Date("2026-09-03T15:40:00.000Z");

describe("the line", () => {
  test("carries an ISO time, the outcome, the status and the duration", () => {
    expect(formatHttpLine(NOW, "GET", "/api/topics", 200, 12))
      .toBe("2026-09-03T15:40:00.000Z [HTTP] ✓ GET /api/topics 200 12ms");
  });

  test("a 4xx and a 5xx are told apart at a glance", () => {
    expect(formatHttpLine(NOW, "POST", "/api/chat", 409, 3)).toContain("⚠️ POST /api/chat 409");
    expect(formatHttpLine(NOW, "GET", "/api/history/x", 500, 900)).toContain("❌ GET /api/history/x 500");
  });
});

describe("the routes on a clock", () => {
  test("are those three, and only those", () => {
    expect(isQuietRoute("/api/browsers/ctx-1/viewers")).toBe(true);
    expect(isQuietRoute("/api/system/presence")).toBe(true);
    expect(isQuietRoute("/api/claude-hooks")).toBe(true);
    expect(isQuietRoute("/api/claude-hooks/pre-tool-use")).toBe(true);
    expect(isQuietRoute("/api/browsers/ctx-1")).toBe(false);
    expect(isQuietRoute("/api/topics/streaming")).toBe(false);
    expect(isQuietRoute("/api/claude-hooksx")).toBe(false);
  });

  test("a fast 200 stays quiet; an error or a slow one speaks", () => {
    expect(shouldLogHttp("/api/browsers/ctx-1/viewers", 200, 5)).toBe(false);
    expect(shouldLogHttp("/api/browsers/ctx-1/viewers", 404, 5)).toBe(true);
    expect(shouldLogHttp("/api/browsers/ctx-1/viewers", 200, SLOW_MS + 1)).toBe(true);
    // The boundary: exactly SLOW_MS is not "over".
    expect(shouldLogHttp("/api/system/presence", 200, SLOW_MS)).toBe(false);
  });

  test("every other API route always writes, even a 200 in 1ms", () => {
    expect(shouldLogHttp("/api/topics", 200, 1)).toBe(true);
    expect(httpLogLine(NOW, "GET", "/api/topics", 200, 1)).not.toBeNull();
    expect(httpLogLine(NOW, "GET", "/api/browsers/ctx-1/viewers", 200, 1)).toBeNull();
  });
});
