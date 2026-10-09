/**
 * The scenarios of `late-reply-recycle.test.ts`, each run in a child `bun test` of its own: the ack caps
 * are read once per process, at import (`server/lib/ai-bridge-client.ts`). A fake daemon on a unix socket;
 * the attach replay trickles past the cap, then the daemon stalls, then sends the attach ack and answers
 * the list; a `list()` armed as the stall starts (`LATE_RECYCLE_CASE=with-list`). The control (`no-list`)
 * runs the same attach with no concurrent list.
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

describe(`a scan past the cap while a list goes mute (${CASE})`, () => {
  test("the late ack lands and the list resolves", async () => {
    const { AiBridgeClient } = await import("../../server/lib/ai-bridge-client");
    // The replay keeps flowing past the 300 ms cap, then the daemon stalls with the ack queued behind it.
    const TRICKLE_MS = 700;
    const ACK_DELAY_MS = 1400;
    let attachAt = 0;
    let attachSock: net.Socket | null = null;
    let trickle: ReturnType<typeof setInterval> | null = null;
    const daemon = net.createServer((sock) => {
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
      const wholeP = c.attachWhole("topic:scan", 0).then((v: unknown) => ({ ok: v }), (e: unknown) => ({ err: e }));
      let listP: Promise<{ ok: unknown } | { err: unknown }> | null = null;
      if (CASE === "with-list") {
        await sleep(750); // armed as the stall starts
        listP = c.list().then((v: unknown) => ({ ok: v }), (e: unknown) => ({ err: e }));
      }
      const out = await wholeP;
      const ms = Date.now() - t0;
      if ("ok" in out) console.log(`[recycle:${CASE}] attach resolved after ${ms} ms`);
      else console.log(`[recycle:${CASE}] attach rejected after ${ms} ms: ${(out.err as Error).name}: ${(out.err as Error).message}`);
      expect("ok" in out).toBe(true);
      if ("ok" in out) expect((out.ok as { endOffset: number }).endOffset).toBe(7);
      if (CASE === "with-list") {
        const listOut = await listP!;
        if ("ok" in listOut) console.log(`[recycle:${CASE}] list resolved`);
        else console.log(`[recycle:${CASE}] list rejected: ${(listOut.err as Error).message}`);
        expect("ok" in listOut).toBe(true);
      }
    } finally {
      if (trickle) clearInterval(trickle);
      try { c.dispose(); } catch { /* already gone */ }
      await new Promise<void>((r) => daemon.close(() => r()));
    }
  }, 20_000);
});
