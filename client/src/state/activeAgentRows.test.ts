/**
 * THE LIST AND THE NUMBER ARE ONE THING.
 *
 * The profile menu lists the agents at work, the card badges how many there
 * are, and the status counts say the same figure. They all come from
 * `activeAgentRowsFrom`, so the interesting cases are the gates: which
 * sessions are rows, which are not, and that every row has a name.
 *
 * A chat waiting on the work its closed turn left running is an agent at work,
 * in the working list (one state since 2026-10-04): it holds a CLI in RAM right
 * now, and nothing about it waits for the person.
 *
 * @covers STATUSLINE-05, BGVIS-03, ATTN-01
 */
import { describe, expect, test } from "bun:test";
import { activeAgentCount, activeAgentRowsFrom, visibleTopicSignalCount, visibleTopicSignalIds } from "./signals";
import type { AttentionSnapshot, AttentionState } from "../../../shared/attention";
import type { Topic } from "../types";

const topic = (id: string, archived = false): Topic => ({ id, name: `chat ${id}`, archived } as Topic);
const none = new Set<string>();
const quiet = { active: none, resting: none, busy: none, liveStream: none, hydratedStream: none, attention: new Map<string, AttentionSnapshot>() };

/**
 * Attention rows: `t:<id>` a chat, `s:<id>` a terminal; `finished` is lit (not
 * seen); `job` is `working` with a Bash left running by a closed turn.
 */
function attention(entries: Record<string, AttentionState | "job">): Map<string, AttentionSnapshot> {
  return new Map(Object.entries(entries).map(([k, given]) => {
    const state: AttentionState = given === "job" ? "working" : given;
    const subject = k.startsWith("s:") ? `terminal:${k.slice(2)}` : `topic:${k.slice(2)}`;
    return [subject, {
      subject, state, reason: state === "needs-you" ? "permission" : null, outcome: state === "finished" ? "done" : null, detail: null,
      since: "", epoch: 1, seenEpoch: 0, lit: state === "needs-you" || state === "finished", unread: 0, turnUnseen: false, lastTurnAt: null,
      background: given === "job" ? [{ id: "b", kind: "bash", label: "x", startedAt: "" }] : [],
    } satisfies AttentionSnapshot];
  }));
}

describe("visibleTopicSignalIds", () => {
  test("the count is the length of the ids, one gate", () => {
    const topics = { a: topic("a"), b: topic("b", true), c: topic("c") };
    const ids = new Set(["a", "b", "c", "ghost"]);
    expect(visibleTopicSignalIds(ids, topics)).toEqual(["a", "c"]);
    expect(visibleTopicSignalCount(ids, topics)).toBe(2);
  });
});

describe("activeAgentRowsFrom", () => {
  const roster = [
    { id: "t1", type: "claude-code", name: "fix the login" },
    { id: "t2", type: "shell", name: "zsh" },
    { id: "t3", type: "opencode", name: "port the tests" },
    { id: "t4", type: "claude-code", name: "resting one" },
  ];

  test("a working terminal is a row named after the session; the shell never is", () => {
    const rows = activeAgentRowsFrom(roster, {}, {
      ...quiet,
      active: new Set(["t1"]),
      busy: new Set(["t2", "t3", "t4"]),
      resting: new Set(["t4"]),
    });
    expect(rows.working).toEqual([
      { id: "t1", kind: "terminal", label: "fix the login" },
      { id: "t3", kind: "terminal", label: "port the tests" },
    ]);
    expect(rows.awaitingInput).toEqual([]);
  });

  test("a chat mid stream is a row named after the topic; archived and deleted ones are not", () => {
    const topics = { a: topic("a"), b: topic("b", true) };
    const rows = activeAgentRowsFrom([], topics, {
      ...quiet,
      liveStream: new Set(["a", "b"]),
      hydratedStream: new Set(["ghost"]),
    });
    expect(rows.working).toEqual([{ id: "a", kind: "topic", label: "chat a" }]);
  });

  test("waiting for an answer reads the attention state of both, and a terminal gone from the roster has no row", () => {
    const topics = { a: topic("a") };
    const rows = activeAgentRowsFrom(roster, topics, { ...quiet, attention: attention({ "s:t1": "needs-you", "s:vanished": "needs-you", "t:a": "needs-you" }) });
    expect(rows.awaitingInput).toEqual([
      { id: "t1", kind: "terminal", label: "fix the login" },
      { id: "a", kind: "topic", label: "chat a" },
    ]);
  });

  test("a turn that ENDED and was not seen is its own list, not the loud one", () => {
    const topics = { a: topic("a"), b: topic("b") };
    const rows = activeAgentRowsFrom(roster, topics, {
      ...quiet,
      attention: attention({ "s:t1": "finished", "s:t3": "finished", "t:a": "finished", "t:b": "needs-you" }),
    });
    expect(rows.awaitingInput).toEqual([{ id: "b", kind: "topic", label: "chat b" }]);
    expect(rows.finished).toEqual([
      { id: "t1", kind: "terminal", label: "fix the login" },
      { id: "t3", kind: "terminal", label: "port the tests" },
      { id: "a", kind: "topic", label: "chat a" },
    ]);
  });

  test("one session is ONE row: its single tier decides the list", () => {
    const topics = { a: topic("a") };
    const rows = activeAgentRowsFrom(roster, topics, { ...quiet, attention: attention({ "s:t1": "needs-you", "t:a": "needs-you" }) });
    expect(rows.awaitingInput).toHaveLength(2);
    expect(rows.finished).toEqual([]);
    expect(rows.working).toEqual([]);
  });

  test("a terminal gone from the roster, or a shell, has no row among the finished either", () => {
    const rows = activeAgentRowsFrom(roster, {}, { ...quiet, attention: attention({ "s:vanished": "finished", "s:t2": "finished" }) });
    expect(rows.finished).toEqual([]);
  });

  test("a chat waiting on its job is an agent at work, never also finished, and the badge counts it", () => {
    const topics = { a: topic("a") };
    const rows = activeAgentRowsFrom([], topics, { ...quiet, attention: attention({ "t:a": "job" }) });
    expect(rows.working).toEqual([{ id: "a", kind: "topic", label: "chat a" }]);
    expect(rows.finished).toEqual([]);
    expect(activeAgentCount(rows)).toBe(1);
  });

  test("a terminal waiting on its job is at work too, with no active phase (its tasks are counted by id)", () => {
    const rows = activeAgentRowsFrom(roster, {}, { ...quiet, attention: attention({ "s:t4": "job" }) });
    expect(rows.working).toEqual([{ id: "t4", kind: "terminal", label: "resting one" }]);
  });

  test("an archived or deleted chat waiting on its job does not count", () => {
    const rows = activeAgentRowsFrom([], { b: topic("b", true) }, { ...quiet, attention: attention({ "t:b": "job", "t:ghost": "job" }) });
    expect(rows.working).toEqual([]);
    expect(activeAgentCount(rows)).toBe(0);
  });

  test("a chat mid reply is ONE row even if its last turn left work behind, and one waiting on its job is the other", () => {
    const topics = { a: topic("a"), b: topic("b") };
    const rows = activeAgentRowsFrom([], topics, {
      ...quiet,
      liveStream: new Set(["a"]),
      attention: attention({ "t:a": "job", "t:b": "job" }),
    });
    expect(rows.working).toEqual([{ id: "a", kind: "topic", label: "chat a" }, { id: "b", kind: "topic", label: "chat b" }]);
    expect(activeAgentCount(rows)).toBe(2);
  });
});
