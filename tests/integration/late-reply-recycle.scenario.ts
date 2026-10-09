/**
 * The scenarios of `late-reply-recycle.test.ts`, each run in a child `bun test` of its own: the ack caps
 * are read once per process, at import (`server/lib/ai-bridge-client.ts`). A fake daemon on a unix socket;
 * the attach replay trickles past the cap, then the daemon stalls, then sends the attach ack and answers
 * the list; a `list()` armed as the stall starts (`LATE_RECYCLE_CASE=with-list`). The control (`no-list`)
 * runs the same attach with no concurrent list. `precap` runs the same pause while the attach is still
 * under its cap (5 s, with 1.5 s of patience for silence), in one attempt: the exit tail's form. `norid`
 * is the other side of the same guard: a daemon that echoes no rids, whose retried socket must go.
 * `abandon`: the exit tail (`attachWhole`, one attempt) given up on takes its socket with it, its replay never
 * lands. `probe`: the lag probe's one-attempt `attach` given up on keeps it, the gap waits. `respawn` and its
 * variants share one body: the same probe, then its process killed and replaced, with the kill landing after
 * the give-up (`respawn`), before it (`respawn-before`), before the resume (`respawn-inflight`), or with a
 * daemon that echoes no rids (`respawn-norid`): the old replay never reaches the successor.
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
} else if (CASE === "abandon") {
  // `abandon`: the exit tail's attach (`attachWhole`, one attempt) and a list behind it, then a pause longer than
  // the attach's patience and shorter than the watchdog. The list's silence keeps the socket, since the
  // attach still waits on it; then the attach gives up. Kept, the socket would deliver its replay once the
  // daemon resumes, into whatever turn the session runs next.
  describe("the exit tail's attach given up on at its last attempt, with a list behind it", () => {
    test("its replay does not reach the session once the daemon resumes", async () => {
      const { AiBridgeClient } = await import("../../server/lib/ai-bridge-client");
      const sockets = new Set<net.Socket>();
      const queued: Array<{ sock: net.Socket; f: any }> = [];
      let paused = false;
      const answer = (sock: net.Socket, f: any) => {
        const write = (m: object) => { if (!sock.destroyed) sock.write(JSON.stringify(m) + "\n"); };
        if (f.type === "ping") write({ type: "pong", pid: 1, rid: f.rid, live: 1 });
        if (f.type === "list") write({ type: "list", sessions: [{ id: "topic:a", alive: true, endOffset: 5 }], rid: f.rid });
        if (f.type === "attach") {
          for (let off = 0; off < 5; off++) write({ type: "data", id: f.id, offset: off, chunk: Buffer.from(`OLD${off}`).toString("base64") });
          write({ type: "attached", id: f.id, endOffset: 5, alive: true, exitCode: null, protocol: 4, rid: f.rid });
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
            if (paused) queued.push({ sock, f });
            else answer(sock, f);
          }
        });
      });
      await new Promise<void>((r) => daemon.listen(sockPath, () => r()));
      const c = new AiBridgeClient();
      try {
        await c.ensureConnected();
        await sleep(150); // the pong is in: rids are echoed
        const landed: number[] = [];
        let givenUp = false;
        c.registerHandlers("topic:a", { onData: (_chunk: Buffer, offset: number) => { if (givenUp) landed.push(offset); }, onExit: () => {} });
        paused = true;
        const attach = c.attachWhole("topic:a", 0, 1).then(() => "resolved", (e: Error) => { givenUp = true; return e.name; });
        await sleep(50); // the list goes out behind the attach
        const list = c.list().then(() => "resolved", (e: Error) => e.name);
        const [a] = await Promise.all([attach, list]);
        await sleep(300); // still paused, past the attach's patience
        paused = false;
        for (const { sock, f } of queued.splice(0)) answer(sock, f);
        await sleep(300); // whatever the resumed daemon sends has arrived
        console.log(`[recycle:abandon] attach: ${a} · frames after it was given up on: ${landed.length}`);
        expect(a).toBe("BridgeAckStalled");
        expect(landed).toEqual([]);
      } finally {
        try { c.dispose(); } catch { /* already gone */ }
        for (const s of sockets) s.destroy();
        await new Promise<void>((r) => daemon.close(() => r()));
      }
    }, 20_000);
  });
} else if (CASE === "probe") {
  // `probe`: the lag probe's attach (`resyncStream(key, { attempts: 1 })`), given up on in a pause longer than
  // its patience and shorter than the watchdog. Its process lives on and folds the late replay once
  // (`admitFrame`); a recycle would resync every live session for a gap that waits anyway, and cut another
  // session streaming on the same socket.
  describe("the lag probe's one-attempt attach given up on in a pause", () => {
    test("keeps the socket: its late replay and another session's stream still arrive", async () => {
      const { AiBridgeClient } = await import("../../server/lib/ai-bridge-client");
      let connections = 0;
      const sockets = new Set<net.Socket>();
      const attachedB = new Set<net.Socket>();
      const queued: Array<{ sock: net.Socket; f: any }> = [];
      let paused = false;
      const write = (sock: net.Socket, m: object) => { if (!sock.destroyed) sock.write(JSON.stringify(m) + "\n"); };
      const answer = (sock: net.Socket, f: any) => {
        if (f.type === "ping") write(sock, { type: "pong", pid: 1, rid: f.rid, live: 2 });
        if (f.type === "attach") {
          if (f.id === "topic:b") attachedB.add(sock);
          for (let off = f.fromOffset; off < 8; off++) write(sock, { type: "data", id: f.id, offset: off, chunk: Buffer.from("x").toString("base64") });
          write(sock, { type: "attached", id: f.id, endOffset: 8, alive: true, exitCode: null, protocol: 4, rid: f.rid });
        }
      };
      const daemon = net.createServer((sock) => {
        connections++;
        sockets.add(sock);
        let buffer = "";
        sock.on("error", () => {});
        sock.on("close", () => { sockets.delete(sock); attachedB.delete(sock); });
        sock.on("data", (c) => {
          buffer += c.toString();
          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            let f: any;
            try { f = JSON.parse(line); } catch { continue; }
            if (paused) queued.push({ sock, f });
            else answer(sock, f);
          }
        });
      });
      await new Promise<void>((r) => daemon.listen(sockPath, () => r()));
      const c = new AiBridgeClient();
      try {
        let reconnects = 0;
        c.onReconnect(() => { reconnects++; });
        await c.ensureConnected();
        await sleep(150); // the pong is in: rids are echoed
        let bFrames = 0;
        c.registerHandlers("topic:b", { onData: () => { bFrames++; }, onExit: () => {} });
        await c.attach("topic:b", 0, 1); // b streams on this socket
        const bBefore = bFrames;
        const late: number[] = [];
        let givenUp = false;
        c.registerHandlers("topic:a", { onData: (_chunk: Buffer, offset: number) => { if (givenUp) late.push(offset); }, onExit: () => {} });
        paused = true;
        const a = await c.attach("topic:a", 3, 1).then(() => "resolved", (e: Error) => { givenUp = true; return e.name; });
        await sleep(300); // still paused, past the attach's patience
        paused = false;
        for (const { sock, f } of queued.splice(0)) answer(sock, f);
        // b's child writes a line after the pause: the daemon sends it to every socket attached to b.
        for (const s of attachedB) write(s, { type: "data", id: "topic:b", offset: 8, chunk: Buffer.from("y").toString("base64") });
        await sleep(300); // whatever the resumed daemon sends has arrived
        const seen = { connections, reconnects, lateReplay: late.length, bAfterPause: bFrames - bBefore };
        console.log(`[recycle:probe] attach: ${a} · ${JSON.stringify(seen)}`);
        expect(a).toBe("BridgeAckStalled");
        expect(seen).toEqual({ connections: 1, reconnects: 0, lateReplay: 5, bAfterPause: 1 });
      } finally {
        try { c.dispose(); } catch { /* already gone */ }
        for (const s of sockets) s.destroy();
        await new Promise<void>((r) => daemon.close(() => r()));
      }
    }, 20_000);
  });
} else if (CASE === "respawn" || CASE === "respawn-before" || CASE === "respawn-inflight" || CASE === "respawn-norid") {
  // `respawn` and its variants: the lag probe's attach, then its process killed and a successor spawned under the
  // same id while the daemon is still paused (Stop and a resend, or /clear and a send). The daemon answers in order:
  // the probe's replay and its ack, then the kill, then the spawn and the successor's output. Frames carry only the
  // id: the old replay must not reach the successor, whose own output must, on the same socket. `respawn` kills after
  // the give-up, `respawn-before` kills before it, `respawn-inflight` resumes before it so the attach still resolves,
  // `respawn-norid` runs the replacement against a daemon that echoes no rids.
  describe("the lag probe's attach, then its process killed and replaced", () => {
    test("the successor gets its own output and none of the old replay", async () => {
      const { AiBridgeClient } = await import("../../server/lib/ai-bridge-client");
      const norid = CASE === "respawn-norid";
      let connections = 0;
      const sockets = new Set<net.Socket>();
      const queued: Array<{ sock: net.Socket; f: any }> = [];
      let paused = false;
      const write = (sock: net.Socket, m: object) => { if (!sock.destroyed) sock.write(JSON.stringify(m) + "\n"); };
      const chunk = (text: string) => Buffer.from(text).toString("base64");
      const answer = (sock: net.Socket, f: any) => {
        if (f.type === "ping") write(sock, norid ? { type: "pong", pid: 1, live: 1 } : { type: "pong", pid: 1, rid: f.rid, live: 1 });
        if (f.type === "attach") {
          for (let off = f.fromOffset; off < 8; off++) write(sock, { type: "data", id: f.id, offset: off, chunk: chunk("old") });
          write(sock, norid
            ? { type: "attached", id: f.id, endOffset: 8, alive: true, exitCode: null, protocol: 3 }
            : { type: "attached", id: f.id, endOffset: 8, alive: true, exitCode: null, protocol: 4, rid: f.rid });
        }
        if (f.type === "spawn") {
          write(sock, norid
            ? { type: "spawned", id: f.id, pid: 2, resumed: false }
            : { type: "spawned", id: f.id, pid: 2, resumed: false, rid: f.rid });
          for (let off = 0; off < 3; off++) write(sock, { type: "data", id: f.id, offset: off, chunk: chunk("new") });
          if (norid) write(sock, { type: "exit", id: f.id, exitCode: 0 });
        }
      };
      const daemon = net.createServer((sock) => {
        connections++;
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
            if (paused) queued.push({ sock, f });
            else answer(sock, f);
          }
        });
      });
      await new Promise<void>((r) => daemon.listen(sockPath, () => r()));
      const c = new AiBridgeClient();
      try {
        let reconnects = 0;
        c.onReconnect(() => { reconnects++; });
        await c.ensureConnected();
        await sleep(150); // the pong is in
        const firstOld: number[] = [];
        c.registerHandlers("topic:a", { onData: (_data: Buffer, offset: number) => { firstOld.push(offset); }, onExit: () => {} });
        const got: string[] = [];
        let exits = 0;
        const replace = () => {
          c.kill("topic:a");
          c.registerHandlers("topic:a", { onData: (data: Buffer) => { got.push(data.toString()); }, onExit: () => { exits++; } });
          return c.spawn("topic:a", { cliPath: "/bin/cat", args: [], cwd: tempDir, env: {} }).then(() => "ok", (e: Error) => e.name);
        };
        const resume = () => {
          paused = false;
          for (const { sock, f } of queued.splice(0)) answer(sock, f);
        };
        const probe = () => c.attach("topic:a", 3, 1).then(() => "resolved", (e: Error) => e.name);
        paused = true;
        let a = "";
        let sp = "";
        if (CASE === "respawn") {
          a = await probe();
          const spawned = replace();
          await sleep(100); // the spawn goes out behind the kill
          resume();
          sp = await spawned;
          await sleep(300); // whatever the resumed daemon sends has arrived
        } else if (CASE === "respawn-before") {
          const attachP = probe();
          await sleep(300); // well before the 1000 ms give-up
          const spawned = replace();
          a = await attachP;
          resume();
          sp = await spawned;
          await sleep(300);
        } else if (CASE === "respawn-inflight") {
          const attachP = probe();
          await sleep(300);
          const spawned = replace();
          await sleep(300); // resume before the give-up: the attach still resolves
          resume();
          a = await attachP;
          sp = await spawned;
          await sleep(300);
        } else {
          a = await probe();
          resume();
          await sleep(300); // the first process folds the late replay
          const spawned = replace(); // the daemon answers at once now
          sp = await spawned;
          await sleep(300);
        }
        if (norid) {
          const seen = { connections, reconnects, firstOld: firstOld.length, old: got.filter((x) => x === "old").length, own: got.filter((x) => x === "new").length, exits };
          console.log(`[recycle:${CASE}] attach: ${a} · spawn: ${sp} · ${JSON.stringify(seen)}`);
          expect([a, sp]).toEqual(["BridgeAckStalled", "ok"]);
          expect(firstOld).toEqual([3, 4, 5, 6, 7]);
          expect(seen).toEqual({ connections: 1, reconnects: 0, firstOld: 5, old: 0, own: 3, exits: 1 });
        } else {
          const seen = { connections, reconnects, old: got.filter((x) => x === "old").length, own: got.filter((x) => x === "new").length };
          console.log(`[recycle:${CASE}] attach: ${a} · spawn: ${sp} · ${JSON.stringify(seen)}`);
          expect([a, sp]).toEqual([CASE === "respawn-inflight" ? "resolved" : "BridgeAckStalled", "ok"]);
          expect(seen).toEqual({ connections: 1, reconnects: 0, old: 0, own: 3 });
        }
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
