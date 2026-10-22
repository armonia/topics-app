/**
 * @covers TERM-13
 *
 * THE BRIDGE THE SERVER REUSES SAYS WHAT IT IS, AND SINCE WHEN.
 *
 * A bridge outlives every server restart, because it holds the live terminals.
 * On 16/10/2026 the one answering on the Mac had started on 7/10, before its
 * `pong` learned to say "node" or "rust": the Performance panel showed "not
 * identified" under a Rust switch that looked like it had done nothing, and
 * nowhere did it say that the switch, and two bridge changes since, were
 * waiting for that process to stop.
 *
 * The bar is a real process holding a real socket, shaped like that bridge: a
 * runtime running `pty-bridge.mjs` whose pong says nothing about itself. The
 * server reuses it, and its status has to name it and date it.
 *
 * In the server's own PATH, too. launchd and the app start it with no /usr/sbin,
 * where macOS keeps `lsof`: the first version of this test ran with the
 * terminal's PATH, was green, and production kept saying "not identified".
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { cleanupTestDataDir, setupTestDataDir, testTmpDir } from "./helpers";

const ROOT = testTmpDir("pty-bridge-identity");
// Short on purpose: a unix socket path cannot exceed 104 characters.
const SOCKET_PATH = join(ROOT, "b.sock");
const SHELL_PATH = process.env.PATH;

// A bridge from before 15/10: it answers, and never says what it is.
const OLD_BRIDGE = `
import net from "node:net";
const server = net.createServer((c) => {
  let pending = "";
  c.on("error", () => {});
  c.on("data", (d) => {
    pending += d;
    let i;
    while ((i = pending.indexOf("\\n")) >= 0) {
      const line = pending.slice(0, i); pending = pending.slice(i + 1);
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === "ping") c.write(JSON.stringify({ type: "pong" }) + "\\n");
      else if (msg.type === "list") c.write(JSON.stringify({ type: "list", sessions: [] }) + "\\n");
    }
  });
});
server.listen(process.argv[2]);
`;

let bridge: ChildProcess | null = null;

beforeAll(async () => {
  setupTestDataDir(join(ROOT, "data"));
  fs.writeFileSync(join(ROOT, "pty-bridge.mjs"), OLD_BRIDGE);
  bridge = spawn(process.execPath, [join(ROOT, "pty-bridge.mjs"), SOCKET_PATH], { stdio: "ignore" });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !fs.existsSync(SOCKET_PATH)) await new Promise((r) => setTimeout(r, 50));
  process.env.PATH = (SHELL_PATH ?? "").split(":").filter((dir) => !dir.endsWith("/sbin")).join(":");
  delete process.env.TOPICS_DISABLE_PTY_BRIDGE;
  delete process.env.TOPICS_EMBEDDED;
}, 30_000);

afterAll(async () => {
  const { disconnectBridge, _setPtyBridgeSocketPath } = await import("../../server/routes/terminal");
  disconnectBridge();
  _setPtyBridgeSocketPath(null);
  bridge?.kill("SIGKILL");
  process.env.PATH = SHELL_PATH;
  await cleanupTestDataDir(ROOT);
});

describe.skipIf(process.platform === "win32")("a reused bridge that does not say what it is", () => {
  test("the status names it Node, with its pid and the time it started", async () => {
    expect(fs.existsSync(SOCKET_PATH), "the old bridge has to be listening, or the test proves nothing").toBe(true);
    const terminal = await import("../../server/routes/terminal");
    terminal.disconnectBridge();
    terminal._setPtyBridgeSocketPath(SOCKET_PATH);
    await terminal.ensureBridge();
    expect(terminal.getPtyBridgeRuntimeStatus().reason).toBe("reused");

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && terminal.getPtyBridgeRuntimeStatus().startedAt == null) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const status = terminal.getPtyBridgeRuntimeStatus();
    expect(status.implementation, "a pong without the field left it 'unknown': the panel said 'not identified'").toBe("node");
    expect(status.pid).toBe(bridge!.pid!);
    const age = Date.now() - Date.parse(status.startedAt!);
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(5 * 60_000);
  }, 30_000);
});
