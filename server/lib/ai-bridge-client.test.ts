import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Integration test: AiBridgeClient ↔ ai-bridge.mjs daemon (the client spawns the
// daemon itself). Isolated via TOPICS_AI_BRIDGE_SOCKET + TOPICS_DATA_DIR so it
// never touches a real bridge. `cat` is the clean-pipe child.

const SOCK = join(tmpdir(), `ai-bridge-client-${process.pid}.sock`);
let dataDir = "";

// Set isolation env BEFORE importing the client (it reads them in its ctor).
process.env.TOPICS_AI_BRIDGE_SOCKET = SOCK;
dataDir = mkdtempSync(join(tmpdir(), "ai-bridge-cli-data-"));
process.env.TOPICS_DATA_DIR = dataDir;

const { AiBridgeClient } = await import("./ai-bridge-client");
let client: InstanceType<typeof AiBridgeClient>;

/** Collect onData chunks for a session with an async waiter. */
function collector() {
  const chunks: Array<{ text: string; offset: number }> = [];
  const waiters: Array<{ pred: (c: { text: string; offset: number }) => boolean; resolve: (c: any) => void }> = [];
  return {
    onData: (buf: Buffer, offset: number) => {
      const c = { text: buf.toString("utf8"), offset };
      const wi = waiters.findIndex((w) => w.pred(c));
      if (wi >= 0) { const [w] = waiters.splice(wi, 1); w.resolve(c); } else chunks.push(c);
    },
    wait: (pred: (c: { text: string; offset: number }) => boolean, timeoutMs = 3000) =>
      new Promise<{ text: string; offset: number }>((res, rej) => {
        const hit = chunks.findIndex(pred);
        if (hit >= 0) { const [c] = chunks.splice(hit, 1); return res(c); }
        const t = setTimeout(() => rej(new Error("data timeout")), timeoutMs);
        waiters.push({ pred, resolve: (c) => { clearTimeout(t); res(c); } });
      }),
  };
}

beforeAll(async () => {
  client = new AiBridgeClient();
  await client.ensureConnected();
});

afterAll(() => {
  // The daemon is detached; kill it via its pidfile.
  try {
    const pidPath = SOCK.replace(/\.sock$/, ".pid");
    if (existsSync(pidPath)) process.kill(Number(readFileSync(pidPath, "utf8").trim()), "SIGTERM");
  } catch { /* already gone */ }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

describe("AiBridgeClient", () => {
  test("connects (spawns the daemon) and points at the isolated socket", () => {
    expect(client.socketPath).toBe(SOCK);
    expect(client.storeDir).toContain(dataDir);
  });

  test("spawn → write → onData delivers stdout with byte offsets", async () => {
    const id = "topic:cli-echo";
    const col = collector();
    client.registerHandlers(id, { onData: col.onData });
    const s = await client.spawn(id, { cliPath: "cat", args: [], cwd: dataDir, env: {} });
    expect(typeof s.pid).toBe("number");

    client.write(id, "alpha\n");
    const a = await col.wait((c) => c.text === "alpha\n");
    expect(a.offset).toBe(0);

    client.write(id, "beta\n");
    const b = await col.wait((c) => c.text === "beta\n");
    expect(b.offset).toBe(6);
  });

  test("hasLiveSession reflects a running child; spawn is idempotent", async () => {
    const id = "topic:cli-idem";
    client.registerHandlers(id, { onData: () => {} });
    const first = await client.spawn(id, { cliPath: "cat", args: [], cwd: dataDir, env: {} });
    expect(await client.hasLiveSession(id)).toBe(true);
    const second = await client.spawn(id, { cliPath: "cat", args: [], cwd: dataDir, env: {} });
    expect(second.resumed).toBe(true);
    expect(second.pid).toBe(first.pid);
  });

  test("attach replays the store from an offset (reattach path)", async () => {
    const id = "topic:cli-attach";
    const col = collector();
    client.registerHandlers(id, { onData: col.onData });
    await client.spawn(id, { cliPath: "cat", args: [], cwd: dataDir, env: {} });
    client.write(id, "one\n");
    await col.wait((c) => c.text === "one\n");
    client.write(id, "two\n");
    await col.wait((c) => c.text === "two\n");

    // Re-attach from offset 0 → the store replays "one\ntwo\n" as one chunk.
    const res = await client.attach(id, 0);
    expect(res.alive).toBe(true);
    expect(res.endOffset).toBe(8);
    const replay = await col.wait((c) => c.offset === 0 && c.text.includes("one\ntwo\n"));
    expect(replay.text).toBe("one\ntwo\n");
  });

  test("kill removes the session", async () => {
    const id = "topic:cli-kill";
    client.registerHandlers(id, { onData: () => {} });
    await client.spawn(id, { cliPath: "cat", args: [], cwd: dataDir, env: {} });
    expect(await client.hasLiveSession(id)).toBe(true);
    client.kill(id);
    // give the daemon a tick to process the kill
    await new Promise((r) => setTimeout(r, 200));
    expect(await client.hasLiveSession(id)).toBe(false);
  });

  test("attach to an unknown id reports missing", async () => {
    const res = await client.attach("topic:nope", 0);
    expect(res.missing).toBe(true);
    expect(res.alive).toBe(false);
  });
});
