/**
 * A terminal that ends must not leave its background jobs behind.
 *
 * Card 30b195ca: mac-health counted 16 processes orphaned by Topics terminals.
 * They were children of a shell that had exited, still alive in its process
 * group. The bridge now signals the whole group when the shell exits.
 *
 * Unix only: the bridge runs under node, and process groups do not exist on
 * Windows.
 */
import { describe, test, expect, afterEach } from "bun:test";
import net from "node:net";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNodeBin, nodeMancanteMessage } from "./lib/test-node-bin";

const BRIDGE = join(import.meta.dir, "pty-bridge.mjs");
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await Bun.sleep(100);
  }
  return pred();
}

describe.skipIf(process.platform === "win32")("pty-bridge · group kill on exit", () => {
  test("a background job of an exited shell does not outlive it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pty-group-"));
    const sock = join(dir, "bridge.sock");
    const pidFile = join(dir, "job.pid");
    const node = resolveNodeBin();
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([node, BRIDGE, "--socket", sock, "--parent-pid", String(process.pid)], {
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch (e) {
      throw new Error(nodeMancanteMessage(node, e));
    }
    cleanups.push(() => {
      try { proc.kill(9); } catch { /* already gone */ }
      rmSync(dir, { recursive: true, force: true });
    });
    expect(await until(() => existsSync(sock), 15_000)).toBe(true);

    const client = net.connect(sock);
    cleanups.push(() => client.destroy());
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    let exited = false;
    let buf = "";
    client.on("data", (d) => {
      buf += d.toString();
      if (buf.includes('"type":"exit"')) exited = true;
    });
    const script = `sleep 300 </dev/null >/dev/null 2>&1 & echo $! > ${pidFile}`;
    client.write(JSON.stringify({ type: "create", id: "group-kill", shell: "/bin/sh", args: ["-c", script], cwd: dir }) + "\n");

    expect(await until(() => exited, 15_000)).toBe(true);
    expect(await until(() => existsSync(pidFile), 5_000)).toBe(true);
    const job = Number(readFileSync(pidFile, "utf8").trim());
    expect(job).toBeGreaterThan(1);
    expect(await until(() => !alive(job), 5_000)).toBe(true);
  }, 60_000);
});
