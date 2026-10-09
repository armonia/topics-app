/**
 * The scenarios of `late-reply-recycle.test.ts`, each run in a child `bun test` of its own: the ack caps
 * are read once per process, at import (`server/lib/ai-bridge-client.ts`). A fake daemon on a unix socket;
 * the attach replay trickles past the cap, then the daemon stalls, then sends the attach ack and answers
 * the list; a `list()` armed as the stall starts (`LATE_RECYCLE_CASE=with-list`). The control (`no-list`)
 * runs the same attach with no concurrent list. `precap` runs the same pause while the attach is still
 * under its cap (5 s, with 1.5 s of patience for silence), in one attempt: the exit tail's form. `norid`
 * is the other side of the same guard: a daemon that echoes no rids, whose retried socket must go.
 */
process.env.TOPICS_AI_BRIDGE_ATTACH_ACK_MS ??= "300";
process.env.TOPICS_AI_BRIDGE_MAX_ACK_MS ??= "300";
process.env.TOPICS_AI_BRIDGE_STALL_TICK_MS ??= "25";
process.env.TOPICS_AI_BRIDGE_ACK_MS ??= "300";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const CASE = process.env.LATE_RECYCLE_CASE ?? "with-list";
// `precap`: the same pause while the attach is still under its cap, in the exit tail's form (one attempt).
const ATTEMPTS = CASE === "precap" ? 1 : undefined;
let tempDir = "";
let sockPath = "";
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string) { savedEnv[k] = process.env[k]; process.env[k] = v; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  const { __resetAiBridgeClientForTests } = await import("../../server/lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
  tempDir = mkdtempSync(join(tmpdir(), "late-reply-recycle-"));
  sockPath = join(tempDir, "ai-bridge.sock");
  setEnv("TOPICS_AI_BRIDGE_SOCKET", sockPath);
  setEnv("TOPICS_DATA_DIR", join(tempDir, "data"));
  setEnv("DATA_DIR", join(tempDir, "data"));
});

afterAll(async () => {
  const { __resetAiBridgeClientForTests } = await import("../../server/lib/ai-bridge-client");
  __resetAiBridgeClientForTests();
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

// `norid`: a daemon older than protocol 4 echoes no rids, so its answers match by shape, oldest waiter
// first. It pauses with a list, a kill and a second list queued in that order: the first list goes mute
// and retries while the second, `hasLiveSession`, still waits. Kept, the socket would hand the second
// list the late answer to the first, the session still there from before the kill.
if (CASE === "norid") {
  describe("a daemon without rids pauses under a list, a kill and a second list", () => {
    test("the list sent after the kill does not find the session", async () => {
      const { AiBridgeClient } = await import("../../server/lib/ai-bridge-client");
      const sessions = new Set(["topic:x"]);
      const sockets = new Set<net.Socket>();
      const queued: Array<{ sock: net.Socket; f: any }> = [];
      let paused = false;
      const answer = (sock: net.Socket, f: any) => {
        const reply = (m: object) => { if (!sock.destroyed) sock.write(JSON.stringify(m) + "\n"); };
        if (f.type === "ping") reply({ type: "pong", pid: 1, live: sessions.size });
        if (f.type === "list") reply({ type: "list", sessions: [...sessions].map((id) => ({ id, alive: true, endOffset: 0 })) });
        if (f.type === "kill") {
          sessions.delete(f.id);
          for (const s of sockets) if (!s.destroyed) s.write(JSON.stringify({ type: "killed", id: f.id }) + "\n");
        }
      };
      const daemon = net.createServer((sock) => {
        sockets.add(sock);
        let buffer = "";
        sock.on("error", () => {});
        sock.on("close", () => sockets.delete(sock));
        sock.on("data", (c) => {
          buffer += c.toString();
          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            let f: any;
            try { f = JSON.parse(line); } catch { continue; }
            // Paused like a stopped process: the lines wait in order and are read when it resumes, also
            // those of a socket the client closed meanwhile (the kill still lands).
            if (paused) queued.push({ sock, f });
            else answer(sock, f);
          }
        });
      });
      await new Promise<void>((r) => daemon.listen(sockPath, () => r()));
      const c = new AiBridgeClient();
      try {
        await c.ensureConnected();
        await sleep(150); // the pong is in, without a rid: the client knows this daemon does not echo them
        paused = true;
        const before = c.list().then((v: Array<{ id: string }>) => v.map((x) => x.id).join(",") || "none", (e: Error) => `rejected ${e.message}`);
        await sleep(300); // the kill goes out behind the first list
        c.kill("topic:x");
        await sleep(300); // the second list goes out behind the kill: mute at 1.6 s, the first at 1.0 s
        const after = c.hasLiveSession("topic:x");
        await sleep(700); // 1.3 s: the first list went mute and retried, the second still waits
        paused = false;
        for (const { sock, f } of queued.splice(0)) answer(sock, f);
        const [b, a] = await Promise.all([before, after]);
        console.log(`[recycle:norid] list sent before the kill: ${b} · hasLiveSession after the kill: ${a}`);
        expect(a).toBe(false);
      } finally {
        try { c.dispose(); } catch { /* already gone */ }
        for (const s of sockets) s.destroy();
        await new Promise<void>((r) => daemon.close(() => r()));
      }
    }, 20_000);
  });
} else {
  describe(`a scan past the cap while a list goes mute (${CASE})`, () => {
    test("the late ack lands and the list resolves", async () => {
      const { AiBridgeClient } = await import("../../server/lib/ai-bridge-client");
      // The replay keeps flowing past the 300 ms cap, then the daemon stalls with the ack queued behind it.
      const TRICKLE_MS = 700;
      const ACK_DELAY_MS = 1400;
      let attachAt = 0;
      let attachSock: net.Socket | null = null;
      let trickle: ReturnType<typeof setInterval> | null = null;
      const conns = new Set<net.Socket>();
      const daemon = net.createServer((sock) => {
        conns.add(sock);
        let buffer = "";
        sock.on("error", () => {});
        sock.on("data", (c) => {
          buffer += c.toString();
          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            let f: any;
            try { f = JSON.parse(line); } catch { continue; }
            if (f.type === "ping" && !sock.destroyed) sock.write(JSON.stringify({ type: "pong", pid: 1, rid: f.rid, live: 1 }) + "\n");
            if (f.type === "attach") {
              attachAt = Date.now();
              attachSock = sock;
              let off = 0;
              trickle = setInterval(() => {
                if (!sock.destroyed) sock.write(JSON.stringify({ type: "data", id: "topic:other", offset: off++, chunk: "eA==" }) + "\n");
              }, 40);
              setTimeout(() => { if (trickle) clearInterval(trickle); trickle = null; }, TRICKLE_MS);
              setTimeout(() => {
                if (attachSock && !attachSock.destroyed) attachSock.write(JSON.stringify({ type: "attached", id: "topic:scan", endOffset: 7, alive: true, exitCode: null, protocol: 4, rid: f.rid }) + "\n");
              }, ACK_DELAY_MS);
            }
            if (f.type === "list") {
              const listSock = sock;
              const listRid = f.rid;
              const now = Date.now();
              const ackAt = attachAt + ACK_DELAY_MS;
              // Queued behind the stall like everything else: answered shortly after it ends.
              const delay = !attachAt || now >= ackAt ? 10 : Math.max(0, ackAt + 50 - now);
              setTimeout(() => {
                if (!listSock.destroyed) listSock.write(JSON.stringify({ type: "list", sessions: [], rid: listRid }) + "\n");
              }, delay);
            }
          }
        });
      });
      await new Promise<void>((r) => daemon.listen(sockPath, () => r()));
      const c = new AiBridgeClient();
      try {
        await c.ensureConnected();
        await sleep(100); // pong in: rids are echoed
        const t0 = Date.now();
        const wholeP = c.attachWhole("topic:scan", 0, ATTEMPTS).then((v: unknown) => ({ ok: v }), (e: unknown) => ({ err: e }));
        let listP: Promise<{ ok: unknown } | { err: unknown }> | null = null;
        if (CASE !== "no-list") {
          await sleep(750); // armed as the stall starts
          listP = c.list().then((v: unknown) => ({ ok: v }), (e: unknown) => ({ err: e }));
        }
        const out = await wholeP;
        const ms = Date.now() - t0;
        if ("ok" in out) console.log(`[recycle:${CASE}] attach resolved after ${ms} ms`);
        else console.log(`[recycle:${CASE}] attach rejected after ${ms} ms: ${(out.err as Error).name}: ${(out.err as Error).message}`);
        expect("ok" in out).toBe(true);
        if ("ok" in out) expect((out.ok as { endOffset: number }).endOffset).toBe(7);
        if (CASE !== "no-list") {
          const listOut = await listP!;
          if ("ok" in listOut) console.log(`[recycle:${CASE}] list resolved`);
          else console.log(`[recycle:${CASE}] list rejected: ${(listOut.err as Error).message}`);
          expect("ok" in listOut).toBe(true);
        }
      } finally {
        if (trickle) clearInterval(trickle);
        try { c.dispose(); } catch { /* already gone */ }
        // The server's own ends too: on Bun 1.3.8 its close could wait on one past the test's timeout.
        for (const s of conns) s.destroy();
        await new Promise<void>((r) => daemon.close(() => r()));
      }
    }, 20_000);
  });
}
