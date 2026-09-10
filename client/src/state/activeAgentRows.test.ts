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
  awaitingTerm: none, awaitingInputTerm: none, finishedTerms: none,
  liveStream: none, hydratedStream: none, awaitingTopics: none, awaitingInputTopics: none,
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

  test("a turn that ENDED is its own list, not the loud one", () => {
    // "N to look at (turn ended or paused)" was a number with no rows, in a
    // row of the account panel that could not be opened. Now it is a list like
    // the other two, and the number on the card is its length.
    const topics = { a: topic("a"), b: topic("b") };
    const rows = activeAgentRowsFrom(roster, topics, {
      ...quiet,
      awaitingTerm: new Set(["t1"]),
      finishedTerms: new Set(["t3"]),
      awaitingTopics: new Set(["a", "b"]),
      awaitingInputTopics: new Set(["b"]),
    });
    expect(rows.awaitingInput).toEqual([{ id: "b", kind: "topic", label: "chat b" }]);
    expect(rows.finished).toEqual([
      { id: "t1", kind: "terminal", label: "fix the login" },
      { id: "t3", kind: "terminal", label: "port the tests" },
      { id: "a", kind: "topic", label: "chat a" },
    ]);
  });

  test("one session is ONE row: the tier that asks for an answer wins", () => {
    // A terminal can have finished its turn AND sit in `awaiting-user`, and a
    // topic can be in both sets. If it appeared in two lists the card's count,
    // which is their sum, would say two things to look at where there is one.
    const topics = { a: topic("a") };
    const rows = activeAgentRowsFrom(roster, topics, {
      ...quiet,
      awaitingTerm: new Set(["t1"]),
      finishedTerms: new Set(["t1"]),
      awaitingInputTerm: new Set(["t1"]),
      awaitingTopics: new Set(["a"]),
      awaitingInputTopics: new Set(["a"]),
    });
    expect(rows.awaitingInput).toHaveLength(2);
    expect(rows.finished).toEqual([]);
  });

  test("a terminal gone from the roster has no row among the finished either", () => {
    // Same gate as the archived topics: an id whose session no longer exists
    // has neither a row nor a tab, so its "1" could not be cleared from
    // anywhere. The roster gate used to apply only to `finishedTerms`, and
    // `awaitingTerm` entered the count without passing through it.
    const rows = activeAgentRowsFrom(roster, {}, {
      ...quiet,
      awaitingTerm: new Set(["vanished"]),
      finishedTerms: new Set(["also-gone", "t2"]),
    });
    // t2 is the shell: not an agent, so it enters no list.
    expect(rows.finished).toEqual([]);
  });
});
