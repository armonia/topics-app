/**
 * A SUB-AGENT THAT ENDS IS MARKED ENDED, NOT LOST.
 *
 * The chat's strip read only the live roster, so a sub-agent whose process
 * exited simply vanished from the chat that spawned it. These cases pin the
 * pure rules that replace that: who counts as ended, when an ended entry goes
 * away, and what the strip lists.
 *
 * @covers SUBSTRIP-01
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_ENDED_SUB_AGENTS,
  recordSubAgentDepartures,
  subAgentRowsFor,
  type EndedSubAgent,
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
    const out = recordSubAgentDepartures([child("a")], [], [], 1000);
    expect(out).toEqual([{ id: "a", name: "agent a", parentSessionKey: CHAT, endedAt: 1000 }]);
  });

  test("a terminal nobody spawned is not a sub-agent, and leaves nothing", () => {
    const none: EndedSubAgent[] = [];
    expect(recordSubAgentDepartures([child("s", { parentSessionKey: null })], [], none, 1)).toBe(none);
  });

  test("a roster that still lists the sub-agent changes nothing, same array back", () => {
    const ended: EndedSubAgent[] = [];
    expect(recordSubAgentDepartures([child("a")], [child("a", { busy: true })], ended, 1)).toBe(ended);
  });

  test("a sub-agent that comes back (resume) is live again, its ended entry dropped", () => {
    const ended = recordSubAgentDepartures([child("a")], [], [], 1);
    expect(recordSubAgentDepartures([], [child("a")], ended, 2)).toEqual([]);
  });

  test("an ended entry is recorded once, with the time of the first roster that missed it", () => {
    const first = recordSubAgentDepartures([child("a")], [], [], 1);
    // A later roster whose "previous" still carries it (a stale cache at boot).
    const again = recordSubAgentDepartures([child("a")], [], first, 99);
    expect(again).toBe(first);
    expect(again[0]!.endedAt).toBe(1);
  });

  test("the list is bounded, the oldest go first", () => {
    let ended: readonly EndedSubAgent[] = [];
    for (let i = 0; i < MAX_ENDED_SUB_AGENTS + 5; i++) {
      ended = recordSubAgentDepartures([child(`c${i}`)], [], ended, i);
    }
    expect(ended.length).toBe(MAX_ENDED_SUB_AGENTS);
    expect(ended[0]!.id).toBe("c5");
    expect(ended[ended.length - 1]!.id).toBe(`c${MAX_ENDED_SUB_AGENTS + 4}`);
  });
});

describe("subAgentRowsFor", () => {
  test("live children of this chat, with their busy state; other chats' children excluded", () => {
    const rows = subAgentRowsFor(CHAT, [child("a", { busy: true }), child("b"), child("x", { parentSessionKey: OTHER })], []);
    expect(rows).toEqual([
      { id: "a", name: "agent a", state: "busy" },
      { id: "b", name: "agent b", state: "idle" },
    ]);
  });

  test("THE OCCURRENCE: the only sub-agent ends, and the chat still lists it, as ended", () => {
    const before = [child("a")];
    const ended = recordSubAgentDepartures(before, [], [], 5);
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
