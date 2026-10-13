import { describe, test, expect, afterAll, setSystemTime } from "bun:test";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A REPLY PAST THE CAP IS STILL A REPLY.
 *
 * The 90 s cap gives up on a request whose bytes were still flowing, and it
 * keeps the socket: the daemon answers later, on that same socket, right behind
 * the replay that was flowing. The client used to drop that answer, and the
 * caller that could not do without it (a re-adoption's scan) failed while its
 * replay went on arriving and got folded as something else. `late` hands it
 * over; `attachWhole` takes it as the attach.
 *
 * The daemon is fake, so the answer comes exactly when the test says. The cap
 * is reached by moving the clock: the waiter checks the wall time at its next
 * tick, and the 90 s are not waited out.
 *
 * @covers RUNTIME-06
 */

const SOCK = join(tmpdir(), `ai-bridge-late-reply-${process.pid}.sock`);
const dataDir = mkdtempSync(join(tmpdir(), "ai-bridge-late-reply-data-"));
const envKeys = ["TOPICS_AI_BRIDGE_SOCKET", "TOPICS_DATA_DIR"] as const;
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
process.env.TOPICS_AI_BRIDGE_SOCKET = SOCK;
process.env.TOPICS_DATA_DIR = dataDir;

const { AiBridgeClient, BridgeAckStalled } = await import("./ai-bridge-client");

type Frame = { type?: string; rid?: number; id?: string };
let server: net.Server | null = null;
let client: InstanceType<typeof AiBridgeClient> | null = null;

/** A fake daemon on the socket, and a fresh client (its constructor reads the socket from the env). */
async function scene(onFrame: (frame: Frame, sock: net.Socket) => void): Promise<InstanceType<typeof AiBridgeClient>> {
  try { client?.dispose(); } catch { /* already closed */ }
  if (server) await new Promise<void>((res) => server!.close(() => res()));
  try { rmSync(SOCK, { force: true }); } catch { /* already gone */ }
  const s = net.createServer((sock) => {
    let buffer = "";
    sock.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        try { onFrame(JSON.parse(line), sock); } catch { /* unreadable frame */ }
      }
    });
    sock.on("error", () => { /* the client drops the socket on purpose */ });
  });
  await new Promise<void>((res) => s.listen(SOCK, () => res()));
  server = s;
  client = new AiBridgeClient();
  return client;
}

afterAll(async () => {
  setSystemTime();
  try { client?.dispose(); } catch { /* already closed */ }
  if (server) await new Promise<void>((res) => server!.close(() => res()));
  try { rmSync(SOCK, { force: true }); } catch { /* already gone */ }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  for (const key of envKeys) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const until = async (ok: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  expect(ok()).toBe(true);
};
/** The cap, as after 90 s of bytes flowing: the waiter sees it at its next tick. */
const pastTheCap = () => setSystemTime(new Date(Date.now() + 120_000));
const attachedReply = (rid: number) => JSON.stringify({ type: "attached", id: "topic:late", endOffset: 42, alive: true, exitCode: null, protocol: 4, rid }) + "\n";
const lateReplyMap = (c: InstanceType<typeof AiBridgeClient>) => (c as unknown as { lateReplies: Map<number, unknown> }).lateReplies;

/** A daemon that echoes rids (it answers a `list` first) and keeps the attach unanswered. */
async function slowAttach() {
  const seen: { rid: number | null; sock: net.Socket | null } = { rid: null, sock: null };
  const c = await scene((frame, sock) => {
    if (frame.type === "list") sock.write(JSON.stringify({ type: "list", sessions: [], rid: frame.rid }) + "\n");
    if (frame.type === "attach") { seen.rid = frame.rid ?? null; seen.sock = sock; }
  });
  await c.list();
  return { c, seen };
}

describe("the reply to a request past its cap", () => {
  test("settles `late`, read as the attach it answers", async () => {
    const { c, seen } = await slowAttach();
    try {
      const attach = c.attach("topic:late", 0).then(() => null, (e: unknown) => e);
      await until(() => seen.rid !== null);
      pastTheCap();
      const err = await attach;
      expect(err).toBeInstanceOf(BridgeAckStalled);
      expect((err as InstanceType<typeof BridgeAckStalled>).retryable).toBe(false);
      seen.sock!.write(attachedReply(seen.rid!));
      expect(await (err as InstanceType<typeof BridgeAckStalled>).late).toMatchObject({ endOffset: 42, alive: true, protocol: 4 });
    } finally { setSystemTime(); }
  }, 15_000);

  test("attachWhole takes it as the attach", async () => {
    const { c, seen } = await slowAttach();
    try {
      const whole = c.attachWhole("topic:late", 0);
      await until(() => seen.rid !== null);
      pastTheCap();
      await until(() => lateReplyMap(c).size === 1);
      seen.sock!.write(attachedReply(seen.rid!));
      expect(await whole).toMatchObject({ endOffset: 42, alive: true });
      expect(lateReplyMap(c).size).toBe(0);
    } finally { setSystemTime(); }
  }, 15_000);

  test("the socket going first settles it empty: attachWhole fails as an attach did", async () => {
    const { c, seen } = await slowAttach();
    try {
      const whole = c.attachWhole("topic:late", 0).then(() => null, (e: unknown) => e);
      await until(() => seen.rid !== null);
      pastTheCap();
      await until(() => lateReplyMap(c).size === 1);
      seen.sock!.destroy();
      expect(await whole).toBeInstanceOf(BridgeAckStalled);
      expect(lateReplyMap(c).size).toBe(0);
    } finally { setSystemTime(); }
  }, 15_000);

  test("from a daemon that never echoed a rid there is none to wait for", async () => {
    let attachSeen = false;
    const c = await scene((frame) => { if (frame.type === "attach") attachSeen = true; });
    try {
      const whole = c.attachWhole("topic:late", 0).then(() => null, (e: unknown) => e);
      await until(() => attachSeen);
      pastTheCap();
      const err = await whole;
      expect(err).toBeInstanceOf(BridgeAckStalled);
      expect((err as InstanceType<typeof BridgeAckStalled>).late).toBeUndefined();
    } finally { setSystemTime(); }
  }, 15_000);
});
