import { describe, test, expect } from "bun:test";
import { browserReapable, type ReapState } from "./browser-idle-reap";

/** @covers BROWSER-REAP-01 */

const idle: ReapState = { connected: true, contexts: 0, creating: 0, launching: false, idleMs: 21 * 60_000, idleTimeoutMs: 5 * 60_000 };

describe("browserReapable", () => {
  test("an idle browser with nothing on it is reaped", () => {
    expect(browserReapable(idle)).toBe(true);
  });

  test("a context still being created keeps the browser, however old the clock", () => {
    expect(browserReapable({ ...idle, creating: 1 })).toBe(false);
  });

  test("a launch in progress keeps the browser", () => {
    expect(browserReapable({ ...idle, launching: true })).toBe(false);
  });

  test("open contexts, a recent use or a dead process are never reaped", () => {
    expect(browserReapable({ ...idle, contexts: 1 })).toBe(false);
    expect(browserReapable({ ...idle, idleMs: 60_000 })).toBe(false);
    expect(browserReapable({ ...idle, connected: false })).toBe(false);
  });
});
