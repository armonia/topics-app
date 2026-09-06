/**
 * THE LIST AND THE NUMBER ARE ONE THING.
 *
 * The profile menu lists the agents at work, the card badges how many there
 * are, and the status counts say the same figure. They all come from
 * `activeAgentRowsFrom`, so the interesting cases are the gates: which
 * sessions are rows, which are not, and that every row has a name.
 *
 * @covers STATUSLINE-05
 */
import { describe, expect, test } from "bun:test";
import { activeAgentRowsFrom, visibleTopicSignalCount, visibleTopicSignalIds } from "./signals";
import type { Topic } from "../types";

const topic = (id: string, archived = false): Topic => ({ id, name: `chat ${id}`, archived } as Topic);
const none = new Set<string>();
const quiet = {
  active: none, resting: none, busy: none,
  awaitingInputTerm: none, liveStream: none, hydratedStream: none, awaitingInputTopics: none,
};

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

  test("awaiting input reads both surfaces, and a terminal gone from the roster has no row", () => {
    const topics = { a: topic("a") };
    const rows = activeAgentRowsFrom(roster, topics, {
      ...quiet,
      awaitingInputTerm: new Set(["t1", "vanished"]),
      awaitingInputTopics: new Set(["a"]),
    });
    expect(rows.awaitingInput).toEqual([
      { id: "t1", kind: "terminal", label: "fix the login" },
      { id: "a", kind: "topic", label: "chat a" },
    ]);
  });
});
