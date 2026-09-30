/**
 * ONE `codex exec` PER THREAD AT A TIME.
 *
 * After a Stop the route closes the turn at once, while the child takes up to
 * KILL_GRACE_MS to die (SIGINT, then SIGKILL). A "send now" in that window
 * started a second `codex exec resume` on the same thread, beside the dying one.
 * The send now waits for the previous child's exit before it does anything, and
 * a Stop pressed while it waits means it never starts.
 *
 * The previous child is a stand-in (an EventEmitter with `kill`), and the spawn
 * of the new turn is observed at its first step: whatever the provider does
 * next (spawn, or say the CLI is missing on this machine) happens only after
 * the previous child's `close`.
 *
 * @covers CHAT-QUEUE-07
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import { CodexProvider } from "./codex";
import type { StreamHandler } from "./types";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { kill: (sig?: string) => boolean; signals: string[] };
  child.signals = [];
  child.kill = (sig?: string) => { child.signals.push(sig ?? "SIGTERM"); return true; };
  return child;
}

function recorder() {
  const events: string[] = [];
  const handler = {
    onTextDelta: () => {},
    onToolStart: () => {},
    onToolResult: () => {},
    onDone: () => { events.push("done"); },
    onError: (e: string) => { events.push(`error:${e}`); },
  } as StreamHandler;
  return { handler, events };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("codex: a send waits for the previous child of its thread", () => {
  test("nothing starts until the dying child has closed", async () => {
    const provider = new CodexProvider({ type: "codex" });
    const previous = fakeChild();
    (provider as any).activeChildren.set("topic:cx", previous);
    const started: string[] = [];
    (provider as any).runCodexTurn = (p: { prompt: string }) => { started.push(p.prompt); };
    const sent = recorder();

    const send = provider.sendChat("topic:cx", "send now", sent.handler);
    await settle();
    expect(started).toEqual([]);
    expect(sent.events).toEqual([]);

    (provider as any).activeChildren.delete("topic:cx");
    previous.emit("close", 130);
    await send;
    // On a machine with the CLI the turn is spawned; without it the provider says so. Either way, only now.
    expect(started.length + sent.events.length).toBe(1);
  });

  test("stopped while it waits: it never starts", async () => {
    const provider = new CodexProvider({ type: "codex" });
    const previous = fakeChild();
    (provider as any).activeChildren.set("topic:cx2", previous);
    const started: string[] = [];
    (provider as any).runCodexTurn = (p: { prompt: string }) => { started.push(p.prompt); };
    const sent = recorder();

    const send = provider.sendChat("topic:cx2", "send now", sent.handler);
    await provider.abort("topic:cx2");
    expect(await send).toEqual({ runId: undefined, notSent: true });
    (provider as any).activeChildren.delete("topic:cx2");
    previous.emit("close", 130);
    await settle();
    expect(started).toEqual([]);
    expect(sent.events).toEqual([]);
  });

  test("no previous child: the send goes at once", async () => {
    const provider = new CodexProvider({ type: "codex" });
    const started: string[] = [];
    (provider as any).runCodexTurn = (p: { prompt: string }) => { started.push(p.prompt); };
    const sent = recorder();
    await provider.sendChat("topic:cx3", "hello", sent.handler);
    expect(started.length + sent.events.length).toBe(1);
  });
});
