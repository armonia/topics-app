/**
 * A SERVER WHOSE LOOP STOOD STILL KEEPS ITS SOCKET, AND ITS CLIS.
 * @covers BRIDGE-01
 *
 * Card 51fb9359 / a1320f75, measured on 25/09: under load the server's loop
 * stood still for up to 287 s. The watchdog ran first when it woke, before the
 * socket's pending bytes were read, took the silence for a dead bridge and
 * recycled a healthy socket. Its reconnect then waited behind the next stall,
 * the daemon (orphaned: its spawner long dead) counted its grace out, shut
 * down, and every CLI mid-turn went with it.
 *
 * The real pieces: the daemon (`ai-bridge.mjs`) with a dead `--parent-pid`, as
 * in production that day, and the client with its production watchdog timings
 * (15 s beat, 45 s pong). Only the daemon's grace is shortened, to 5 s, so that
 * the second stall outlasts it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sock = join(tmpdir(), `ai-bridge-freeze-${process.pid}.sock`);
const store = mkdtempSync(join(tmpdir(), "ai-bridge-freeze-store-"));
process.env.TOPICS_AI_BRIDGE_SOCKET = sock;
const { AiBridgeClient } = await import("./ai-bridge-client");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The loop, held: nothing else in this process runs meanwhile. */
function stall(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* held */ }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const cleanup: Array<() => void> = [];
afterAll(() => {
  for (const f of cleanup.reverse()) { try { f(); } catch { /* best effort */ } }
  try { process.kill(Number(readFileSync(sock.replace(/\.sock$/, ".pid"), "utf8")), "SIGKILL"); } catch { /* gone */ }
  try { rmSync(store, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("the ai-bridge through a stalled server loop", () => {
  test("a loop held 60 s, then held past the daemon's grace: the socket is not recycled, the CLI lives", async () => {
    const corpse = Bun.spawn(["/usr/bin/true"], { stdout: "ignore", stderr: "ignore" });
    await corpse.exited;
    const daemon = Bun.spawn(
      [process.execPath, join(import.meta.dir, "..", "ai-bridge.mjs"), "--socket", sock, "--store-dir", store, "--parent-pid", String(corpse.pid)],
      {
        stdout: "ignore", stderr: "ignore",
        env: { ...process.env, TOPICS_AI_BRIDGE_ORPHAN_GRACE_MS: "5000", TOPICS_AI_BRIDGE_MONITOR_TICK_MS: "500", TOPICS_AI_BRIDGE_REAL_CLIENT_MS: "1000" },
      },
    );
    cleanup.push(() => daemon.kill("SIGKILL"));
    for (let i = 0; i < 100 && !existsSync(sock); i++) await sleep(100);

    const client = new AiBridgeClient();
    cleanup.push(() => client.dispose());
    await client.ensureConnected();
    const { pid } = await client.spawn("topic:freeze", { cliPath: "/bin/sleep", args: ["600"], cwd: "/", env: {} });
    cleanup.push(() => process.kill(pid, "SIGKILL"));
    // Attached long enough to count as a server that came back.
    await sleep(3_000);
    const socketBefore = (client as unknown as { socket: unknown }).socket;

    // Held 60 s: longer than the 45 s the watchdog waits for a pong. Then,
    // once the timers due meanwhile have run, held again past the daemon's
    // grace: a reconnect scheduled in between would still be waiting.
    await new Promise<void>((done) => setTimeout(() => {
      stall(60_000);
      setTimeout(() => { stall(8_000); done(); }, 0);
    }, 0));
    await sleep(2_000);

    const after = { sameSocket: (client as unknown as { socket: unknown }).socket === socketBefore, cliAlive: alive(pid) };
    expect(after).toEqual({ sameSocket: true, cliAlive: true });
  }, 120_000);
});
