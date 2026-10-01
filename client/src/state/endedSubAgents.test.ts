/**
 * A SUB-AGENT THAT ENDS IS MARKED ENDED, NOT LOST.
 *
 * The chat's strip read only the live roster, so a sub-agent whose process
 * exited simply vanished from the chat that spawned it. These cases pin the
 * pure rules that replace that: who counts as ended, when an ended entry goes
 * away, and what the strip lists.
 *
 * @covers SUBSTRIP-01 SUBSTRIP-01c SUBSTRIP-01d
 */
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  EMPTY_MEMORY,
  MAX_ENDED_SUB_AGENTS,
  dismissInMemory,
  recordSubAgentDepartures,
  subAgentRowsFor,
  type EndedSubAgent,
  type SubAgentMemory,
} from "./endedSubAgents";

const CHAT = "topic:chat-1";
const OTHER = "topic:chat-2";

const child = (id: string, over: Partial<{ parentSessionKey: string | null; busy: boolean; name: string }> = {}) => ({
  id,
  name: over.name ?? `agent ${id}`,
  parentSessionKey: over.parentSessionKey === undefined ? CHAT : over.parentSessionKey,
  busy: over.busy ?? false,
});


describe("recordSubAgentDepartures", () => {
  test("a sub-agent that leaves the roster is recorded as ended, with its parent", () => {
    const out = recordSubAgentDepartures([child("a")], [], EMPTY_MEMORY, 1000);
    expect(out.ended).toEqual([{ id: "a", name: "agent a", parentSessionKey: CHAT, endedAt: 1000 }]);
  });

  test("a terminal nobody spawned is not a sub-agent, and leaves nothing", () => {
    expect(recordSubAgentDepartures([child("s", { parentSessionKey: null })], [], EMPTY_MEMORY, 1)).toBe(EMPTY_MEMORY);
  });

  test("a roster that still lists the sub-agent changes nothing, same object back", () => {
    expect(recordSubAgentDepartures([child("a")], [child("a", { busy: true })], EMPTY_MEMORY, 1)).toBe(EMPTY_MEMORY);
  });

  test("a sub-agent that comes back (resume) is live again, its ended entry dropped", () => {
    const memory = recordSubAgentDepartures([child("a")], [], EMPTY_MEMORY, 1);
    expect(recordSubAgentDepartures([], [child("a")], memory, 2).ended).toEqual([]);
  });

  test("an ended entry is recorded once, with the time of the first roster that missed it", () => {
    const first = recordSubAgentDepartures([child("a")], [], EMPTY_MEMORY, 1);
    // A later roster whose "previous" still carries it (a stale cache at boot).
    const again = recordSubAgentDepartures([child("a")], [], first, 99);
    expect(again).toBe(first);
    expect(again.ended[0]!.endedAt).toBe(1);
  });

  test("the list is bounded, the oldest go first", () => {
    let memory: SubAgentMemory = EMPTY_MEMORY;
    for (let i = 0; i < MAX_ENDED_SUB_AGENTS + 5; i++) {
      memory = recordSubAgentDepartures([child(`c${i}`)], [], memory, i);
    }
    expect(memory.ended.length).toBe(MAX_ENDED_SUB_AGENTS);
    expect(memory.ended[0]!.id).toBe("c5");
    expect(memory.ended[memory.ended.length - 1]!.id).toBe(`c${MAX_ENDED_SUB_AGENTS + 4}`);
  });
});

describe("a dismissal", () => {
  test("takes the ended row away", () => {
    const memory = recordSubAgentDepartures([child("a"), child("b")], [], EMPTY_MEMORY, 1);
    expect(dismissInMemory(memory, "a").ended.map((e) => e.id)).toEqual(["b"]);
  });

  test("THE OCCURRENCE: closing a LIVE sub-agent's tab, then the roster without it, leaves no ended row", () => {
    // The tab's X dismisses while the sub-agent still runs; the server then
    // retires the session and the next roster no longer lists it. Before the
    // fix that roster recorded it as ended: the closed tab came back as a row.
    const closed = dismissInMemory(EMPTY_MEMORY, "a");
    const after = recordSubAgentDepartures([child("a")], [], closed, 5);
    expect(subAgentRowsFor(CHAT, [], after.ended)).toEqual([]);
  });

  test("a roster that still lists the closed sub-agent (the retire is in flight) keeps the dismissal", () => {
    const closed = dismissInMemory(EMPTY_MEMORY, "a");
    const between = recordSubAgentDepartures([child("a")], [child("a")], closed, 2);
    expect(recordSubAgentDepartures([child("a")], [], between, 3).ended).toEqual([]);
  });

  test("is spent when the sub-agent comes back: a later end is recorded again", () => {
    const closed = recordSubAgentDepartures([child("a")], [], dismissInMemory(EMPTY_MEMORY, "a"), 1);
    const revived = recordSubAgentDepartures([], [child("a")], closed, 2);
    expect(revived.dismissed).toEqual([]);
    expect(recordSubAgentDepartures([child("a")], [], revived, 3).ended.map((e) => e.id)).toEqual(["a"]);
  });

  test("is idempotent, and the remembered ids are bounded", () => {
    const once = dismissInMemory(EMPTY_MEMORY, "a");
    expect(dismissInMemory(once, "a")).toBe(once);
    let memory: SubAgentMemory = EMPTY_MEMORY;
    for (let i = 0; i < MAX_ENDED_SUB_AGENTS + 3; i++) memory = dismissInMemory(memory, `d${i}`);
    expect(memory.dismissed.length).toBe(MAX_ENDED_SUB_AGENTS);
    expect(memory.dismissed[0]).toBe("d3");
  });
});

/**
 * The store itself, in its own process: it keeps module state and wires a
 * window listener, neither of which may leak into other unit files. Two
 * windows of one browser share localStorage; `other` below writes to it the
 * way the other window's store does, and `storage()` fires the event the
 * browser sends to every OTHER window.
 */
function runStore(steps: string): { rows: string[]; stored: SubAgentMemory | null; notified: number } {
  const script = `
    const cache = new Map();
    const storageListeners = [];
    globalThis.localStorage = {
      getItem: (k) => cache.get(k) ?? null,
      setItem: (k, v) => cache.set(k, String(v)),
      removeItem: (k) => cache.delete(k),
    };
    globalThis.window = { addEventListener: (type, cb) => { if (type === "storage") storageListeners.push(cb); } };
    const KEY = "topics:ended-sub-agents";
    const other = (memory) => cache.set(KEY, JSON.stringify(memory));
    const storage = () => { for (const cb of storageListeners) cb({ key: KEY }); };
    const store = await import(${JSON.stringify(resolve(import.meta.dir, "endedSubAgents.ts"))});
    const sub = (id) => ({ id, name: "agent " + id, parentSessionKey: "topic:chat-1" });
    let notified = 0;
    let rows = [];
    const read = () => { rows = store.subAgentMemorySnapshot().ended.map((e) => e.id); };
    store.subscribeSubAgentMemory(() => { notified++; read(); });
    ${steps}
    read();
    process.stdout.write(JSON.stringify({ rows, stored: JSON.parse(cache.get(KEY) ?? "null"), notified }));
  `;
  const child = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
  return JSON.parse(new TextDecoder().decode(child.stdout));
}

describe("two windows of one browser", () => {
  test("THE OCCURRENCE: a write in this window keeps a row the other window dismissed dismissed", () => {
    const out = runStore(`
      store.noteTerminalRosterReplaced([sub("alpha"), sub("beta")], []);
      // The other window dismisses alpha. Its storage event has not reached
      // this window yet, which is when this window writes (beta dismissed).
      const stored = JSON.parse(cache.get(KEY));
      other({ ended: stored.ended.filter((e) => e.id !== "alpha"), dismissed: ["alpha"] });
      store.dismissSubAgent("beta");
    `);
    // Before the fix this window wrote back its own copy, alpha included.
    expect(out.stored?.ended ?? []).toEqual([]);
    expect(out.stored?.dismissed).toEqual(["alpha", "beta"]);
    expect(out.rows).toEqual([]);
  });

  test("the other window's change reaches this one through the storage event", () => {
    const out = runStore(`
      store.noteTerminalRosterReplaced([sub("alpha")], []);
      const before = notified;
      other({ ended: [], dismissed: ["alpha"] });
      storage();
      if (notified === before) throw new Error("no re-render after the storage event");
    `);
    expect(out.rows).toEqual([]);
  });
});

describe("subAgentRowsFor", () => {
  test("a live child's state comes from its transcript phase, not from PTY bytes (SUBAGENT-16)", () => {
    const rows = subAgentRowsFor(CHAT, [
      { ...child("w", { busy: false }), subAgentPhase: "waiting-prompt" as const },
      { ...child("b", { busy: false }), subAgentPhase: "working" as const },
      { ...child("f", { busy: true }), subAgentPhase: "finished" as const },
    ], []);
    expect(rows.map((r) => [r.id, r.state])).toEqual([["w", "waiting"], ["b", "busy"], ["f", "idle"]]);
  });

  test("live children of this chat, with their busy state; other chats' children excluded", () => {
    const rows = subAgentRowsFor(CHAT, [child("a", { busy: true }), child("b"), child("x", { parentSessionKey: OTHER })], []);
    expect(rows).toEqual([
      { id: "a", name: "agent a", state: "busy" },
      { id: "b", name: "agent b", state: "idle" },
    ]);
  });

  test("THE OCCURRENCE: the only sub-agent ends, and the chat still lists it, as ended", () => {
    const before = [child("a")];
    const { ended } = recordSubAgentDepartures(before, [], EMPTY_MEMORY, 5);
    // Before the fix the strip computed its rows from the live roster alone:
    // empty, so the strip returned null and the sub-agent vanished.
    expect(subAgentRowsFor(CHAT, [], ended)).toEqual([{ id: "a", name: "agent a", state: "ended" }]);
    // And it belongs to its own chat only.
    expect(subAgentRowsFor(OTHER, [], ended)).toEqual([]);
  });

  test("a live row wins over a stale ended entry for the same id", () => {
    const ended: EndedSubAgent[] = [{ id: "a", name: "agent a", parentSessionKey: CHAT, endedAt: 1 }];
    expect(subAgentRowsFor(CHAT, [child("a", { busy: true })], ended)).toEqual([{ id: "a", name: "agent a", state: "busy" }]);
  });

  test("live first, ended after", () => {
    const ended: EndedSubAgent[] = [{ id: "old", name: "old one", parentSessionKey: CHAT, endedAt: 1 }];
    expect(subAgentRowsFor(CHAT, [child("new")], ended).map((r) => `${r.id}:${r.state}`)).toEqual(["new:idle", "old:ended"]);
  });
});
