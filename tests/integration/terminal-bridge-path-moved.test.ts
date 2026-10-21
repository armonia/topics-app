/**
 * @covers TERM-01
 *
 * MOVING THE BRIDGE'S SOCKET PATH LEAVES NO ATTEMPT BEHIND ON THE OLD ONE.
 *
 * Every integration file with a fake bridge points the router at it through
 * `_setPtyBridgeSocketPath`, and `bun test` runs them all in ONE process. An
 * `ensureBridge` still in flight from the file before used to finish against
 * the file after: it adopted a socket to the old path, or spawned a real
 * bridge on the new one, and whoever was waiting on it returned connected to
 * that. In CI (runs 39410049634, 39679742478, 39685856594) this was
 * `terminal-claude-hooks-settings.test.ts` red in 4 ms: its `create` frame
 * went to a real bridge left on the default path, and its own fake recorded
 * nothing.
 *
 * Production never moves the path, so the guards are no-ops there. Each case
 * below is an interleaving that one of them answers alone.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import { createInterface } from "node:readline";
import { testTmpDir } from "./helpers";

const ROOT = testTmpDir("bridge-path-moved");
// Short on purpose: a unix socket path cannot exceed 104 characters.
const OLD_PATH = `${ROOT}/a.sock`;
const NEW_PATH = `${ROOT}/b.sock`;
// It exists, so `tryConnect` tries it, and the connect fails: a plain file, not a socket.
const NOT_A_SOCKET = `${ROOT}/f.sock`;
const BRIDGE_BIN = `${ROOT}/bridge.sh`;
const SPAWN_LOG = `${ROOT}/spawned.txt`;

const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined) {
  savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k]; else process.env[k] = v;
}

const openBridges: Array<{ close(): Promise<void> }> = [];

/** A bridge that only records what it is sent. */
function fakeBridge(path: string) {
  const received: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => { /* the router closes when it likes */ });
    createInterface({ input: socket }).on("line", (line) => {
      try { received.push((JSON.parse(line) as { type: string }).type); } catch { /* not a frame */ }
    });
  });
  const bridge = {
    received,
    listening: new Promise<void>((resolve) => server.listen(path, () => resolve())),
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
  openBridges.push(bridge);
  return bridge;
}

let terminal: typeof import("../../server/routes/terminal");

beforeAll(async () => {
  setEnv("TOPICS_DISABLE_PTY_BRIDGE", undefined);
  setEnv("TOPICS_EMBEDDED", undefined);
  // A spawn, if one happens, runs this and leaves its argv here: never a real bridge.
  fs.writeFileSync(BRIDGE_BIN, `#!/bin/sh\necho "$@" >> ${SPAWN_LOG}\nexec sleep 5\n`, { mode: 0o755 });
  setEnv("TOPICS_PTY_BRIDGE_BIN", BRIDGE_BIN);
  terminal = await import("../../server/routes/terminal");
  // The sockets closed here must not schedule a reconnect into the next file.
  terminal._suppressPtyBridgeReconnectForTest(true);
});

// Each case starts with no socket: one left connected by the other would make
// `ensureBridge` return before it reaches the step under test.
beforeEach(() => terminal.disconnectBridge());
afterEach(async () => {
  terminal.disconnectBridge();
  await Promise.all(openBridges.splice(0).map((b) => b.close()));
});

afterAll(() => {
  terminal.disconnectBridge();
  terminal._setPtyBridgeSocketPath(null);
  terminal._suppressPtyBridgeReconnectForTest(false);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("a connect still in flight when the path moves is dropped, and the caller waiting on it reaches the new path", async () => {
  const oldBridge = fakeBridge(OLD_PATH);
  const newBridge = fakeBridge(NEW_PATH);
  await Promise.all([oldBridge.listening, newBridge.listening]);

  terminal._setPtyBridgeSocketPath(OLD_PATH);
  const stale = terminal.ensureBridge();
  terminal._setPtyBridgeSocketPath(NEW_PATH);
  await Promise.all([stale, terminal.ensureBridge()]);

  // The connected socket says hello with a `ping`: it tells which bridge it is.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !newBridge.received.includes("ping")) await Bun.sleep(10);
  expect(newBridge.received).toContain("ping");
  expect(oldBridge.received).toEqual([]);
}, 10_000);

test("a connect that fails after the path moved spawns no bridge on the new path", async () => {
  fs.writeFileSync(NOT_A_SOCKET, "");
  terminal._setPtyBridgeSocketPath(NOT_A_SOCKET);
  const stale = terminal.ensureBridge();
  terminal._setPtyBridgeSocketPath(`${ROOT}/nobody.sock`);
  await stale;
  // A spawn would have been for a path nobody asked this attempt for.
  expect(fs.existsSync(SPAWN_LOG) ? fs.readFileSync(SPAWN_LOG, "utf8") : "").toBe("");
}, 10_000);
