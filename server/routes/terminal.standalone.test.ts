// Standalone-mode gate for the PTY bridge.
//
// The 2026-07-02 incident: a compiled server sidecar sharing the repo cwd hashed to
// the SAME bridge socket as the live server and reconcile-killed its 25 live PTYs.
// The structural defense is TOPICS_DISABLE_PTY_BRIDGE / TOPICS_EMBEDDED: when set,
// ensureBridge() must NEVER open a socket (so reconcile can never send a `kill`).
// This test proves exactly that — with the flag set, ensureBridge opens no socket.

import { test, expect, spyOn, afterEach } from "bun:test";
import net from "net";
import { ensureBridge, isPtyBridgeDisabled } from "./terminal";

const FLAGS = ["TOPICS_DISABLE_PTY_BRIDGE", "TOPICS_EMBEDDED"] as const;

afterEach(() => {
  for (const f of FLAGS) delete process.env[f];
});

test("isPtyBridgeDisabled reads both flag spellings, live", () => {
  for (const f of FLAGS) delete process.env[f];
  expect(isPtyBridgeDisabled()).toBe(false);
  process.env.TOPICS_DISABLE_PTY_BRIDGE = "1";
  expect(isPtyBridgeDisabled()).toBe(true);
  delete process.env.TOPICS_DISABLE_PTY_BRIDGE;
  process.env.TOPICS_EMBEDDED = "1";
  expect(isPtyBridgeDisabled()).toBe(true);
  process.env.TOPICS_EMBEDDED = "0";
  expect(isPtyBridgeDisabled()).toBe(false);
});

for (const flag of FLAGS) {
  test(`ensureBridge() opens NO socket when ${flag}=1 (standalone)`, async () => {
    // Spy on the ONLY call that opens the bridge socket (tryConnect → net.connect).
    // If ensureBridge short-circuits on the flag, this is never invoked.
    const connectSpy = spyOn(net, "connect").mockImplementation(((..._args: unknown[]) => {
      throw new Error("net.connect must NOT be called in standalone mode");
    }) as unknown as typeof net.connect);

    process.env[flag] = "1";
    // Must resolve without throwing AND without touching net.connect.
    await ensureBridge();
    expect(connectSpy).toHaveBeenCalledTimes(0);

    connectSpy.mockRestore();
  });
}
