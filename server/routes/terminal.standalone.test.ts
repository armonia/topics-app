/**
 * @covers TERM-07
 */
// Standalone-mode gate for the PTY bridge.
//
// The 2026-07-02 incident: a compiled server sidecar sharing the repo cwd hashed to
// the SAME bridge socket as the live server and reconcile-killed its 25 live PTYs.
// The structural defense is TOPICS_DISABLE_PTY_BRIDGE / TOPICS_EMBEDDED: when set,
// ensureBridge() must NEVER open a socket (so reconcile can never send a `kill`).
// This test proves exactly that — with the flag set, ensureBridge opens no socket.

import { test, expect, spyOn, afterEach } from "bun:test";
import fs from "node:fs";
import net from "net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { choosePtyBridgeCommand, newestFileMtime, resolvePtyBridgeCommand } from "../lib/pty-bridge-selection";
import { ensureBridge, getPtyBridgeRuntimeStatus, isPtyBridgeDisabled, _setPtyBridgeSocketPath, _suppressPtyBridgeReconnectForTest } from "./terminal";

const FLAGS = ["TOPICS_DISABLE_PTY_BRIDGE", "TOPICS_EMBEDDED"] as const;
// TOPICS_NODE_BIN / TOPICS_PTY_BRIDGE_PATH (the removed legacy Node bridge) are kept
// here only so the cleanup hook wipes them and the regression test below is honest.
const BUNDLE_ENV = ["TOPICS_PTY_BRIDGE_BIN", "TOPICS_NODE_BIN", "TOPICS_PTY_BRIDGE_PATH"] as const;
let bridgeSocketPath: string | null = null;

afterEach(() => {
  for (const f of FLAGS) delete process.env[f];
  for (const f of BUNDLE_ENV) delete process.env[f];
  if (bridgeSocketPath) {
    process.env.TOPICS_DISABLE_PTY_BRIDGE = "1";
    _setPtyBridgeSocketPath(null);
    bridgeSocketPath = null;
  }
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

test("the bundled Rust bridge binary RE-ENABLES terminals even under a standalone flag", () => {
  // The fresh-install fix: the Tauri shell ships a self-contained Rust bridge binary
  // and points the otherwise-standalone sidecar at it via TOPICS_PTY_BRIDGE_BIN.
  process.env.TOPICS_EMBEDDED = "1";
  expect(isPtyBridgeDisabled()).toBe(true);

  process.env.TOPICS_PTY_BRIDGE_BIN = "/Applications/Topics.app/Contents/MacOS/pty-bridge";
  expect(isPtyBridgeDisabled()).toBe(false); // Rust bridge present — terminals allowed
});

test("the removed legacy Node bridge envs no longer re-enable terminals", () => {
  // The legacy bundled-Node flavour (TOPICS_NODE_BIN + TOPICS_PTY_BRIDGE_PATH) was
  // dropped in the 2026-07 env audit: every shipped bundle uses the Rust sidecar.
  // Setting the old envs must NOT flip the standalone gate anymore.
  process.env.TOPICS_EMBEDDED = "1";
  expect(isPtyBridgeDisabled()).toBe(true);

  process.env.TOPICS_NODE_BIN = "/Applications/Topics.app/Contents/Resources/node";
  process.env.TOPICS_PTY_BRIDGE_PATH = "/Applications/Topics.app/Contents/Resources/pty-bridge.mjs";
  expect(isPtyBridgeDisabled()).toBe(true); // legacy envs are inert — still disabled
});

test("TOPICS_PTY_BRIDGE_BIN ha precedenza e seleziona il bridge esplicito", () => {
  expect(resolvePtyBridgeCommand("/tmp/selected-rust-bridge")).toMatchObject({
    cmd: "/tmp/selected-rust-bridge",
    implementation: "rust",
    reason: "override",
  });
});

test("la scelta del bridge Rust richiede opt-in e binario aggiornato", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "pty-bridge-selection-"));
  const binary = join(dir, "bridge");
  const source = join(dir, "src.rs");
  fs.writeFileSync(binary, "binary");
  fs.writeFileSync(source, "source");
  try {
    fs.utimesSync(binary, 1_700_000_000, 1_700_000_000);
    fs.utimesSync(source, 1_700_000_001, 1_700_000_001);
    const base = { override: null, checkoutBinary: binary, binaryMtimeMs: fs.statSync(binary).mtimeMs, newestSourceMtimeMs: newestFileMtime([source]), nodePath: "/repo/server/pty-bridge.mjs" };
    expect(choosePtyBridgeCommand({ ...base, enabled: false })).toMatchObject({ implementation: "node", reason: "disabled" });
    expect(choosePtyBridgeCommand({ ...base, enabled: true, checkoutBinary: null, binaryMtimeMs: null })).toMatchObject({ implementation: "node", reason: "notBuilt" });
    expect(choosePtyBridgeCommand({ ...base, enabled: true })).toMatchObject({ implementation: "node", reason: "stale" });
    fs.utimesSync(binary, 1_700_000_002, 1_700_000_002);
    const fresh = { ...base, binaryMtimeMs: fs.statSync(binary).mtimeMs };
    expect(choosePtyBridgeCommand({ ...fresh, enabled: true })).toMatchObject({ cmd: binary, implementation: "rust" });
    expect(choosePtyBridgeCommand({ ...fresh, enabled: false, override: "/explicit/bridge" })).toMatchObject({ cmd: "/explicit/bridge", implementation: "rust", reason: "override" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test("ensureBridge riusa un socket vivo anche quando è selezionato il bridge Rust", async () => {
  const socketPath = `/tmp/topics-pty-reuse-${process.pid}.sock`;
  bridgeSocketPath = socketPath;
  process.env.TOPICS_PTY_BRIDGE_BIN = "/missing/rust-bridge-must-not-start";
  _setPtyBridgeSocketPath(socketPath);
  const peerSockets: net.Socket[] = [];
  const liveBridge = net.createServer((socket) => peerSockets.push(socket));
  await new Promise<void>((resolve, reject) => {
    liveBridge.once("error", reject);
    liveBridge.listen(socketPath, resolve);
  });

  try {
    await ensureBridge();
    expect(getPtyBridgeRuntimeStatus()).toMatchObject({
      implementation: "unknown",
      reason: "reused",
      connected: true,
    });
  } finally {
    _suppressPtyBridgeReconnectForTest(true);
    for (const socket of peerSockets) socket.destroy();
    await new Promise<void>((resolve) => liveBridge.close(() => resolve()));
    const deadline = Date.now() + 2000;
    while (getPtyBridgeRuntimeStatus().connected && Date.now() < deadline) await Bun.sleep(10);
    expect(getPtyBridgeRuntimeStatus().connected).toBe(false);
    _setPtyBridgeSocketPath(null);
    _suppressPtyBridgeReconnectForTest(false);
    bridgeSocketPath = null;
  }
});
