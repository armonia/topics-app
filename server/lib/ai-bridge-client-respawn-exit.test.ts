/**
 * AN OLD CHILD'S EXIT IS NOT THE NEW CHILD'S.
 *
 * The daemon's `exit` frame names only the session id. Measured 24/09 by the
 * adversarial check (3 runs out of 8, broker mode): Stop, send, then /clear
 * within half a second. `kill` dropped the old handlers, the waiting send
 * spawned a new child at once, and the killed child died before the daemon
 * read that spawn. With no successor registered yet the daemon broadcast the
 * exit, and the client handed it to the NEW turn's handlers, which closed the
 * message as "Process exited with code null" before it started.
 *
 * Until the daemon acks a spawn, an exit for that id can only be about the
 * previous incarnation (the daemon writes `spawned` in the same tick it starts
 * the child), so it is dropped. After the ack, exits go through as before.
 * @covers CCLI-04
 */
import { describe, expect, test } from "bun:test";
import { AiBridgeClient } from "./ai-bridge-client";

function clientWithParkedSpawn() {
  const client = new AiBridgeClient();
  // The request is parked: the spawn frame "went out", the ack has not come.
  let ack!: (frame: unknown) => void;
  (client as any).request = () => new Promise((resolve) => { ack = resolve; });
  const exits: Array<number | null> = [];
  client.registerHandlers("topic:t", { onData: () => {}, onExit: (code) => exits.push(code) });
  const spawned = client.spawn("topic:t", { cliPath: "/bin/false", args: [], cwd: "/", env: {} } as never);
  const frame = (msg: object) => (client as any).handleFrame(msg);
  return { client, exits, spawned, frame, ack: (msg: object) => { frame(msg); ack(msg); } };
}

describe("ai-bridge client: exit frames around a respawn", () => {
  test("an exit that arrives before the new spawn's ack is the old child's: dropped", async () => {
    const { exits, spawned, frame, ack } = clientWithParkedSpawn();
    frame({ type: "exit", id: "topic:t", exitCode: null });
    expect(exits).toEqual([]);
    ack({ type: "spawned", id: "topic:t", pid: 42 });
    expect(await spawned).toEqual({ pid: 42, resumed: false });
  });

  test("after the ack, the new child's exit reaches its handlers", async () => {
    const { exits, spawned, frame, ack } = clientWithParkedSpawn();
    ack({ type: "spawned", id: "topic:t", pid: 42 });
    await spawned;
    frame({ type: "exit", id: "topic:t", exitCode: 1 });
    expect(exits).toEqual([1]);
  });

  test("ack and exit in the same chunk: the exit is the new child's and is delivered", () => {
    const { exits, frame, ack } = clientWithParkedSpawn();
    // Same synchronous pass, before any promise callback of `spawn` runs.
    ack({ type: "spawned", id: "topic:t", pid: 42 });
    frame({ type: "exit", id: "topic:t", exitCode: 1 });
    expect(exits).toEqual([1]);
  });

  test("a failed spawn does not leave the window open", async () => {
    const { exits, spawned, frame, ack } = clientWithParkedSpawn();
    ack({ type: "error", id: "topic:t", error: "spawn failed: ENOENT" });
    await expect(spawned).rejects.toThrow("ENOENT");
    frame({ type: "exit", id: "topic:t", exitCode: 1 });
    expect(exits).toEqual([1]);
  });
});
