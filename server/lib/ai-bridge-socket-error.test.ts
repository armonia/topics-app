/**
 * @covers RUNTIME-06
 *
 * A DEAD AI BRIDGE MUST NOT TAKE THE PROCESS WITH IT.
 *
 * `setupReader` builds a `readline.Interface` over the daemon socket. Bun from
 * 1.3.8 on, like Node since v20, re-emits every `error` of the input stream on
 * the Interface itself, and an `error` with no listener is rethrown from
 * `emit`. This server installs no `uncaughtException` handler, so one
 * `write EPIPE` on that socket - the daemon hanging up while a frame is in
 * flight - killed the whole process instead of scheduling the reconnect that
 * the `close` handler right below already implements.
 *
 * MEASURED, not deduced: CI run 35269750073, job 105366102078 (PR #80,
 * 2026-09-17 20:20:37). The test server died with exit code 1 on
 * `error: write EPIPE ... at failWrite (node:net:60:30)`, one line after
 * `[AI Bridge] socket closed - reconnecting`. Playwright reported it as
 * 68 failed / 235 never ran: a crash wearing the costume of a red suite.
 * The PTY bridge had already been cured of exactly this in
 * `routes/terminal.ts:943`; this client had not.
 *
 * THE BAR. The socket error is raised the way the kernel raises it, on the
 * socket, and the test asserts the process is still alive to answer afterwards.
 * It fails by CRASHING the test runner, not by a red assertion, which is the
 * honest shape for this defect.
 */
import { describe, test, expect, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOCK = join(tmpdir(), `ai-bridge-epipe-${process.pid}.sock`);
const dataDir = mkdtempSync(join(tmpdir(), "ai-bridge-epipe-data-"));
process.env.TOPICS_AI_BRIDGE_SOCKET = SOCK;
process.env.TOPICS_DATA_DIR = dataDir;

const { AiBridgeClient } = await import("./ai-bridge-client");

/**
 * A daemon that answers `list` and nothing else. It never spawns children: the
 * only thing under test is what happens to THIS process when its socket breaks.
 */
function startFakeDaemon(): Promise<{ hangUp: () => void; close: () => Promise<void> }> {
  try { fs.unlinkSync(SOCK); } catch { /* it was not there */ }
  const live = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    live.add(socket);
    socket.on("close", () => live.delete(socket));
    socket.on("error", () => { /* the hang-up below is deliberate */ });
    const rl = createInterface({ input: socket });
    rl.on("error", () => { /* same error, already absorbed on the socket */ });
    rl.on("line", (line) => {
      let msg: { type?: string };
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === "list") socket.write(JSON.stringify({ type: "list", sessions: [] }) + "\n");
      else if (msg.type === "ping") socket.write(JSON.stringify({ type: "pong" }) + "\n");
    });
  });
  return new Promise((resolve) =>
    server.listen(SOCK, () =>
      resolve({
        hangUp: () => { for (const s of live) s.destroy(); },
        close: () => new Promise((r) => { for (const s of live) s.destroy(); server.close(() => r()); }),
      }),
    ),
  );
}

let daemon: Awaited<ReturnType<typeof startFakeDaemon>> | null = null;
let client: InstanceType<typeof AiBridgeClient> | null = null;

afterAll(async () => {
  try { client?.dispose(); } catch { /* already down */ }
  await daemon?.close();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* gone */ }
  try { fs.unlinkSync(SOCK); } catch { /* gone */ }
});

describe("il socket dell'AI Bridge che si rompe", () => {
  test("un errore sul socket non uccide il processo, e il client si rialza", async () => {
    daemon = await startFakeDaemon();
    client = new AiBridgeClient();
    await client.ensureConnected();
    expect(await client.list()).toEqual([]);

    // This is the production sequence, in order: the daemon hangs up, and the
    // error surfaces on the socket while the reader is attached to it. Before
    // the fix the readline copy of this error had no listener and was rethrown
    // out of `emit`, past every try/catch, and out of the process.
    const socket = (client as unknown as { socket: net.Socket | null }).socket;
    expect(socket).not.toBeNull();
    daemon.hangUp();
    socket!.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE", syscall: "write", errno: -32 }));

    // Still here: the crash would have taken the runner down above this line.
    await new Promise((r) => setTimeout(r, 50));
    expect(process.exitCode ?? 0).toBe(0);

    // And the reconnect the `close` handler schedules is not collateral damage
    // of the fix: the client talks to the same daemon again.
    await new Promise((r) => setTimeout(r, 900));
    expect(await client.list()).toEqual([]);
  }, 10_000);
});
