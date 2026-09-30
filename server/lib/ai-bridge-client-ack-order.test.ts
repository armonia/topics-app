/**
 * ONE ACK ANSWERS ONE REQUEST.
 *
 * The daemon's acks carry only the frame type and the session id, so two
 * requests of the same kind for the same id wait on identical predicates. The
 * client used to hand the first matching frame to EVERY waiter. Measured in
 * CI (run 36703298057, claude-code-broker-resilience.test.ts:237): a socket
 * reconnect re-attached the live session, the caller then killed it and
 * resynced, and the "attached, alive" answer to the reconnect's attach also
 * resolved the resync that was sent AFTER the kill. The daemon's own answer to
 * that resync ("missing") reached nobody, and a killed child was reported
 * alive: its turn could only hang.
 *
 * The daemon reads each socket's lines in order and answers every request in
 * the same tick, so on one socket the answers come back in the order the
 * requests went out: the oldest matching waiter is the one a frame answers.
 *
 * Wire order breaks the moment a reply goes missing or outlives its waiter,
 * so since protocol 4 every request carries a `rid` the daemon echoes, and a
 * frame with a `rid` answers that request or nobody. Order stays the fallback
 * for a daemon older than that, which outlives deploys and echoes nothing.
 * @covers CCLI-04
 */
import { describe, expect, jest, test } from "bun:test";
import { AiBridgeClient, BridgeAckStalled, isRetryableBridgeError } from "./ai-bridge-client";

function connectedClient() {
  const client = new AiBridgeClient();
  const sent: any[] = [];
  const c = client as any;
  c.socket = { destroyed: false, write: (line: string) => { sent.push(JSON.parse(line)); return true; }, destroy() {} };
  c.ready = true;
  const frame = (msg: object) => c.handleFrame(msg);
  return { client, sent, frame, dispose: () => { c.failWaiters(new Error("test over")); } };
}

describe("ai-bridge client: acks are matched to requests in wire order", () => {
  test("two attaches in flight for one id: each gets its own answer, not the first one twice", async () => {
    const { client, sent, frame } = connectedClient();
    const first = client.attach("topic:t", 0);
    // `request` awaits ensureConnected before arming: let both reach the wire.
    await new Promise((r) => setTimeout(r, 0));
    const second = client.attach("topic:t", 0);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.map((f) => f.type)).toEqual(["attach", "attach"]);

    frame({ type: "attached", id: "topic:t", endOffset: 10, alive: true, exitCode: null });
    frame({ type: "attached", id: "topic:t", endOffset: 0, alive: false, exitCode: null, missing: true });

    expect(await first).toMatchObject({ alive: true, missing: false });
    expect(await second).toMatchObject({ alive: false, missing: true });
  });

  test("a frame for another id or type does not consume the waiter", async () => {
    const { client, frame, dispose } = connectedClient();
    let settled = false;
    const pending = client.attach("topic:a", 0).then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 0));
    frame({ type: "attached", id: "topic:b", endOffset: 0, alive: true, exitCode: null });
    frame({ type: "list", sessions: [] });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    frame({ type: "attached", id: "topic:a", endOffset: 3, alive: true, exitCode: null });
    expect(await pending).toMatchObject({ endOffset: 3, alive: true });
    dispose();
  });

  test("two lists in flight each resolve with their own answer", async () => {
    const { client, frame } = connectedClient();
    const first = client.list();
    await new Promise((r) => setTimeout(r, 0));
    const second = client.list();
    await new Promise((r) => setTimeout(r, 0));
    frame({ type: "list", sessions: [{ id: "topic:t", alive: true }] });
    frame({ type: "list", sessions: [] });
    expect((await first).length).toBe(1);
    expect((await second).length).toBe(0);
  });
});

describe("ai-bridge client: a reply echoing a rid answers that request or nobody (protocol 4)", () => {
  test("a late ack for a waiter the 90 s cap already rejected does not answer the next request of the same shape", async () => {
    // The cap rejects NON-retryable while bytes keep flowing, and request()
    // throws without dropping the socket: that attach's answer still arrives,
    // on the live socket, after the caller has moved on (killed, resynced).
    jest.useFakeTimers();
    const { client, sent, frame, dispose } = connectedClient();
    const c = client as any;
    try {
      let firstError: unknown = null;
      const first = client.attach("topic:t", 0).catch((e) => { firstError = e; });
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(sent.length).toBe(1);
      // Bytes of other sessions keep the bridge "busy, not mute" until the cap.
      for (let s = 0; s <= 91 && firstError === null; s++) {
        c.lastByteAt = Date.now();
        jest.advanceTimersByTime(1_000);
        await Promise.resolve();
      }
      await first;
      expect(firstError).toBeInstanceOf(BridgeAckStalled);
      expect(isRetryableBridgeError(firstError)).toBe(false);

      const second = client.attach("topic:t", 0);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(sent.length).toBe(2);

      frame({ type: "attached", id: "topic:t", endOffset: 10, alive: true, exitCode: null, rid: sent[0].rid });
      frame({ type: "attached", id: "topic:t", endOffset: 0, alive: false, exitCode: null, missing: true, rid: sent[1].rid });
      expect(await second).toMatchObject({ alive: false, missing: true });
      expect(typeof sent[0].rid).toBe("number");
      expect(sent[1].rid).not.toBe(sent[0].rid);
    } finally {
      dispose();
      jest.useRealTimers();
    }
  });

  test("a failed write's error, echoing the write's rid, does not reject a spawn in flight for the same id", async () => {
    const { client, sent, frame, dispose } = connectedClient();
    let spawnError: unknown = null;
    const spawning = client.spawn("topic:t", { cliPath: "claude", args: [], cwd: "/", env: {} })
      .catch((e) => { spawnError = e; return null; });
    await new Promise((r) => setTimeout(r, 0));
    client.write("topic:t", "hello\n");
    expect(sent.map((f) => f.type)).toEqual(["spawn", "write"]);

    frame({ type: "error", id: "topic:t", error: "no live session", rid: sent[1].rid });
    await new Promise((r) => setTimeout(r, 0));
    expect(spawnError).toBeNull();
    expect(typeof sent[1].rid).toBe("number");
    expect(sent[1].rid).not.toBe(sent[0].rid);

    frame({ type: "spawned", id: "topic:t", pid: 4242, rid: sent[0].rid });
    expect(await spawning).toEqual({ pid: 4242, resumed: false });
    dispose();
  });

  test("an error echoing an attach's rid rejects that attach instead of reading as a dead session", async () => {
    const { client, sent, frame } = connectedClient();
    let err: unknown = null;
    const attaching = client.attach("topic:t", 0).catch((e) => { err = e; return null; });
    await new Promise((r) => setTimeout(r, 0));
    frame({ type: "error", id: "topic:t", error: "store open failed", rid: sent[0].rid });
    expect(await attaching).toBeNull();
    expect(String((err as Error)?.message)).toContain("store open failed");
  });

  test("a spawned echoing the rid of a spawn that gave up does not open the gate to the new spawn's predecessor exit", async () => {
    const { client, sent, frame, dispose } = connectedClient();
    const exits: Array<number | null> = [];
    client.registerHandlers("topic:t", { onData() {}, onExit: (code) => exits.push(code) });
    const spawning = client.spawn("topic:t", { cliPath: "claude", args: [], cwd: "/", env: {} }).catch(() => null);
    await new Promise((r) => setTimeout(r, 0));
    // An ack for a spawn whose waiter is gone (the 90 s cap), then the killed
    // predecessor's exit: it must not reach the handlers of the turn starting now.
    frame({ type: "spawned", id: "topic:t", pid: 1, rid: sent[0].rid + 1000 });
    frame({ type: "exit", id: "topic:t", exitCode: 143 });
    expect(exits).toEqual([]);
    frame({ type: "spawned", id: "topic:t", pid: 2, rid: sent[0].rid });
    expect(await spawning).toEqual({ pid: 2, resumed: false });
    frame({ type: "exit", id: "topic:t", exitCode: 0 });
    expect(exits).toEqual([0]);
    dispose();
  });

  test("the ack of an earlier spawn, overtaken by a kill and a respawn, does not open the gate to its own child's exit", async () => {
    const { client, sent, frame, dispose } = connectedClient();
    const spawnOpts = { cliPath: "claude", args: [], cwd: "/", env: {} };
    const first = client.spawn("topic:t", spawnOpts).catch(() => null);
    await new Promise((r) => setTimeout(r, 0));
    client.kill("topic:t");
    const exits: Array<number | null> = [];
    client.registerHandlers("topic:t", { onData() {}, onExit: (code) => exits.push(code) });
    const second = client.spawn("topic:t", spawnOpts).catch(() => null);
    await new Promise((r) => setTimeout(r, 0));
    const [spawnA, , spawnB] = sent;
    expect(sent.map((f) => f.type)).toEqual(["spawn", "kill", "spawn"]);

    // The daemon read spawn A, then the kill: B had not reached it yet, so the
    // killed child's exit goes out with no successor to hide it.
    frame({ type: "spawned", id: "topic:t", pid: 1, rid: spawnA.rid });
    frame({ type: "killed", id: "topic:t" });
    frame({ type: "exit", id: "topic:t", exitCode: 143 });
    expect(exits).toEqual([]);
    frame({ type: "spawned", id: "topic:t", pid: 2, rid: spawnB.rid });
    expect(await second).toEqual({ pid: 2, resumed: false });
    expect(await first).toEqual({ pid: 1, resumed: false });
    frame({ type: "exit", id: "topic:t", exitCode: 0 });
    expect(exits).toEqual([0]);
    dispose();
  });

  test("an old daemon echoes no rid: requests still carry one each, and its acks still resolve oldest first", async () => {
    const { client, sent, frame } = connectedClient();
    const first = client.attach("topic:t", 0);
    await new Promise((r) => setTimeout(r, 0));
    const second = client.attach("topic:t", 0);
    await new Promise((r) => setTimeout(r, 0));
    const rids = sent.map((f) => f.rid);
    expect(rids.every((r) => typeof r === "number")).toBe(true);
    expect(new Set(rids).size).toBe(2);

    // Protocol 3: the reply has no `rid`, so wire order is the correlation.
    frame({ type: "attached", id: "topic:t", endOffset: 10, alive: true, exitCode: null });
    frame({ type: "attached", id: "topic:t", endOffset: 0, alive: false, exitCode: null, missing: true });
    expect(await first).toMatchObject({ alive: true, missing: false });
    expect(await second).toMatchObject({ alive: false, missing: true });
  });
});
