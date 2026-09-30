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
 * @covers CCLI-04
 */
import { describe, expect, test } from "bun:test";
import { AiBridgeClient } from "./ai-bridge-client";

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
