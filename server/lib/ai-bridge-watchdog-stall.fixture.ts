/**
 * Run by `ai-bridge-loop-freeze.test.ts` in a process of its own, so that the
 * watchdog's timings come from this process's environment
 * (TOPICS_AI_BRIDGE_WATCHDOG_MS / _PONG_MS, read once at import).
 *
 * A fake daemon on `sock`, and a loop that stands still for 2.6 s right after
 * every watchdog beat (Atomics.wait: no CPU, just a loop that does not run).
 *   mute     the daemon accepts and never writes a byte
 *   answers  it answers every ping with a pong
 * Stops at the first recycle or after `cycles` pings. Prints one JSON line:
 * `{ mode, pings, recycledAfterMs, sameSocket }`.
 */
import net from "node:net";
import { existsSync, unlinkSync } from "node:fs";

const [sock, mode, cycles] = [process.argv[2]!, process.argv[3]!, Number(process.argv[4] ?? 8)];
if (existsSync(sock)) unlinkSync(sock);
const server = net.createServer((c: net.Socket) => {
  c.on("error", () => {});
  if (mode !== "answers") return;
  let pending = "";
  c.on("data", (d: Buffer) => {
    pending += d.toString();
    let nl;
    while ((nl = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (line.includes('"ping"')) c.write('{"type":"pong"}\n');
    }
  });
});
await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(sock, resolve); });
process.env.TOPICS_AI_BRIDGE_SOCKET = sock;
const { AiBridgeClient } = await import("./ai-bridge-client");

const stall = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const client = new AiBridgeClient();
await client.ensureConnected();
const c = client as unknown as { socket: unknown; send: (m: { type: string }) => boolean };
const first = c.socket;
let pings = 0;
const send = c.send.bind(client);
c.send = (m) => {
  const ok = send(m);
  if (m.type === "ping" && ++pings > 1) setTimeout(() => stall(2_600), 50);
  return ok;
};

const t0 = Date.now();
let recycledAfterMs = -1;
while (pings < cycles && recycledAfterMs < 0) {
  await new Promise((r) => setTimeout(r, 100));
  if (c.socket !== first) recycledAfterMs = Date.now() - t0;
}
console.log(JSON.stringify({ mode, pings, recycledAfterMs, sameSocket: c.socket === first }));
client.dispose();
server.close();
process.exit(0);
