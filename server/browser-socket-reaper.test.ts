import { describe, expect, test } from "bun:test";
import { reapBrowserSocket } from "./browser-socket-reaper";

/** @covers NATIVE-HOST-07 */
describe("browser socket reaper", () => {
  test("withdraws a host through the close path before closing the stale socket", () => {
    const socket = {};
    const sockets = new Set([socket]);
    const calls: string[] = [];
    reapBrowserSocket("ctx", socket, sockets, {
      unregisterExecutor: () => calls.push("unregister"),
      unregisterLiveness: () => calls.push("liveness"),
      hostClosed: (_ws, contextId) => calls.push(`onClose:${contextId}`),
      close: (code, reason) => calls.push(`close:${code}:${reason}`),
    });
    expect(calls).toEqual(["unregister", "liveness", "onClose:ctx", "close:1001:Connection timeout"]);
    expect(sockets.size).toBe(0);
  });
});
