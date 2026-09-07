/**
 * A create nobody is waiting for any more MUST NOT take the server with it.
 *
 * THE DEFECT THAT PRODUCED THIS FILE, measured on a Windows machine during an
 * e2e run (card 9a577eb9): the pty bridge was unreachable, `POST
 * /api/terminal/sessions` answered 502 straight away, and five seconds later
 * the whole test server was gone with
 *
 *   error: Bridge did not ack create within 5000ms
 *
 * The 502 was correct. The corpse was not. The wait for the bridge's ack is
 * armed BEFORE the create message is written to the socket; when that write
 * throws synchronously the `await` is never reached, so the deadline that
 * fires later rejects a promise that has no recipient — and an unhandled
 * rejection is fatal in Bun. One unreachable bridge therefore cost the entire
 * server: 163 specs of that shard never ran, and every one of them was red
 * with ECONNREFUSED, accusing code that was fine. On a real machine the same
 * branch costs a person their server instead of their terminal.
 *
 * The assertions here are about the ORPHAN answer, the one that arrives after
 * everybody left: it must be delivered to nobody, quietly. The listener
 * installed below is what turns Bun's fatal exit into a readable failure —
 * without it a regression would not fail this file, it would abort the run.
 *
 * @covers TERM-10
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { BridgeCreateAcks } from "./bridge-create-ack";

const orphans: unknown[] = [];
const record = (reason: unknown) => {
  orphans.push(reason);
};

beforeAll(() => {
  process.on("unhandledRejection", record);
});
afterAll(() => {
  process.off("unhandledRejection", record);
});
afterEach(() => {
  orphans.length = 0;
});

const settleQueue = () => new Promise((r) => setTimeout(r, 40));

describe("an ack nobody awaits", () => {
  test("the deadline fires with no waiter left and the process survives", async () => {
    const acks = new BridgeCreateAcks();
    // Exactly the production sequence: arm the wait, then the write to the
    // socket throws, so nothing ever awaits this promise.
    acks.wait("session-a", 10);
    await settleQueue();
    expect(orphans, "a deadline with no waiter must not reach the process").toEqual([]);
  });

  test("giving up cancels the countdown instead of leaving a fuse", async () => {
    const acks = new BridgeCreateAcks();
    acks.wait("session-b", 10);
    acks.cancel("session-b");
    expect(acks.size).toBe(0);
    await settleQueue();
    expect(orphans).toEqual([]);
  });

  test("a superseded create is failed without the failure escaping", async () => {
    const acks = new BridgeCreateAcks();
    acks.wait("session-c", 1000);
    const second = acks.wait("session-c", 1000);
    acks.settle("session-c", 4242);
    expect(await second).toBe(4242);
    await settleQueue();
    expect(orphans, "the abandoned first waiter is failed, not broadcast").toEqual([]);
  });
});

describe("the waiter still gets the truth", () => {
  test("the deadline reaches whoever is awaiting it", async () => {
    const acks = new BridgeCreateAcks();
    const pending = acks.wait("session-d", 10);
    await expect(pending).rejects.toThrow(/did not ack create within 10ms/);
    expect(acks.size).toBe(0);
  });

  test("the pid comes back when the bridge acks", async () => {
    const acks = new BridgeCreateAcks();
    const pending = acks.wait("session-e", 1000);
    acks.settle("session-e", 31337);
    expect(await pending).toBe(31337);
    expect(acks.size).toBe(0);
  });

  test("the bridge's own words come back when it refuses", async () => {
    const acks = new BridgeCreateAcks();
    const named = acks.wait("session-f", 1000);
    const anonymous = acks.wait("session-g", 1000);
    acks.fail("session-f", new Error("spawn-helper is not executable"));
    await expect(named).rejects.toThrow(/spawn-helper/);
    // The bridge answers errors from a catch block that does not know the id,
    // so an untargeted failure has to reach everyone still waiting.
    acks.failAll(new Error("bridge died"));
    await expect(anonymous).rejects.toThrow(/bridge died/);
    expect(acks.size).toBe(0);
  });

  test("a cancelled id is free again and its ghost cannot steal the next ack", async () => {
    const acks = new BridgeCreateAcks();
    acks.wait("session-h", 10);
    acks.cancel("session-h");
    const retry = acks.wait("session-h", 1000);
    await settleQueue(); // the first deadline would have fired by now
    acks.settle("session-h", 7);
    expect(await retry).toBe(7);
    expect(orphans).toEqual([]);
  });
});
