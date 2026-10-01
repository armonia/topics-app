/**
 * @covers USERROW-01
 *
 * A `user` row that nobody typed says so - and one that somebody typed does not.
 *
 * The second half is the one that gives the first any meaning: a mark on every
 * row would say nothing at all. See `user-row-marks.ts` for the two turns that
 * wear the person's role without being the person.
 *
 * @covers CHAT-USERROW-01
 * @covers CHAT-ENV-01
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { repeatedRowMarks, userRowMarks } from "./user-row-marks";

describe("userRowMarks", () => {
  test("the person's own words carry nothing", () => {
    expect(userRowMarks({})).toBeUndefined();
    expect(userRowMarks({ dispatched: false, goalNudge: 0 })).toBeUndefined();
    // `undefined`, never an empty array: an empty `blocks` column would claim
    // "we looked and found nothing" where the truth is there was nothing to mark.
    expect(userRowMarks({})).not.toEqual([]);
  });

  test("the board's envelope is marked", () => {
    expect(userRowMarks({ dispatched: true })).toEqual([{ kind: "dispatched-envelope" }]);
  });

  test("the goal continuation carries its attempt number", () => {
    expect(userRowMarks({ goalNudge: 3 })).toEqual([{ kind: "goal-nudge", attempt: 3 }]);
    // A fractional or bogus value is not a continuation to invent one from.
    expect(userRowMarks({ goalNudge: 2.7 })).toEqual([{ kind: "goal-nudge", attempt: 2 }]);
    expect(userRowMarks({ goalNudge: "2" })).toBeUndefined();
    expect(userRowMarks({ goalNudge: -1 })).toBeUndefined();
  });

  test("both at once: a dispatched turn the goal loop carried on", () => {
    expect(userRowMarks({ goalNudge: 1, dispatched: true })).toEqual([
      { kind: "goal-nudge", attempt: 1 },
      { kind: "dispatched-envelope" },
    ]);
  });

  test("a resume envelope carries the ids of the comments it delivers", () => {
    expect(userRowMarks({ dispatched: true, commentIds: ["c1", "c2"] })).toEqual([
      { kind: "dispatched-envelope", commentIds: ["c1", "c2"] },
    ]);
  });

  test("no ids without the envelope: they would anchor words this row never carried", () => {
    expect(userRowMarks({ commentIds: ["c1"] })).toBeUndefined();
    expect(userRowMarks({ dispatched: false, commentIds: ["c1"] })).toBeUndefined();
    expect(userRowMarks({ goalNudge: 1, commentIds: ["c1"] })).toEqual([{ kind: "goal-nudge", attempt: 1 }]);
  });

  test("an empty or junk list leaves the kickoff envelope bare", () => {
    // A kickoff delivers no comment at all, and `commentIds: []` would be it
    // claiming otherwise.
    expect(userRowMarks({ dispatched: true, commentIds: [] })).toEqual([{ kind: "dispatched-envelope" }]);
    expect(userRowMarks({ dispatched: true, commentIds: ["", null, 7] })).toEqual([{ kind: "dispatched-envelope" }]);
    expect(userRowMarks({ dispatched: true, commentIds: "c1" })).toEqual([{ kind: "dispatched-envelope" }]);
  });
});

describe("a resend of the envelope is still the envelope (card 46617a7f)", () => {
  test("Retry or the resume sweep resending the envelope's text keeps its mark, without the comment ids", () => {
    const envelope = [{ kind: "dispatched-envelope" as const, commentIds: ["c0"] }];
    expect(userRowMarks({ repeats: envelope })).toEqual([{ kind: "dispatched-envelope" }]);
    // A real dispatch says more, and wins: it carries its own ids.
    expect(userRowMarks({ dispatched: true, repeats: envelope, commentIds: ["c1"] }))
      .toEqual([{ kind: "dispatched-envelope", commentIds: ["c1"] }]);
  });
});

describe("a resend of any row the machine wrote keeps its marks (cross-review of tornata 2c)", () => {
  test("a command's wake and a goal's continuation, resent as bare text, are still the machine's", () => {
    const wake = [{ kind: "process-exit" as const, processId: "p-1", exitCode: 1, label: "bun run build" }];
    expect(userRowMarks({ repeats: wake })).toEqual(wake);
    expect(userRowMarks({ repeats: [{ kind: "goal-nudge", attempt: 2 }] })).toEqual([{ kind: "goal-nudge", attempt: 2 }]);
  });

  test("a row with a mark of its own keeps only its own", () => {
    expect(userRowMarks({ goalNudge: 3, repeats: [{ kind: "goal-nudge", attempt: 2 }] })).toEqual([{ kind: "goal-nudge", attempt: 3 }]);
  });
});

describe("repeatedRowMarks", () => {
  function dbWith(rows: Array<{ content: string; blocks: string | null }>): Database {
    const db = new Database(":memory:");
    db.run("CREATE TABLE messages (session_key TEXT, role TEXT, content TEXT, blocks TEXT, sort_order INTEGER)");
    rows.forEach((r, i) => db.run("INSERT INTO messages VALUES ('s', 'user', ?, ?, ?)", [r.content, r.blocks, i]));
    return db;
  }
  const wake = { kind: "process-exit", processId: "p-1", exitCode: 1, label: "x" };

  test("the marks of the chat's last user row, when the text repeats it word for word", () => {
    const db = dbWith([{ content: "Command `x` finished: exit 1.", blocks: JSON.stringify([wake]) }]);
    expect(repeatedRowMarks(db, "s", "Command `x` finished: exit 1.")).toEqual([wake] as never);
    expect(repeatedRowMarks(db, "s", "Command `x` finished")).toBeUndefined();
  });

  test("nothing from a row the person wrote, nor from an older row", () => {
    const db = dbWith([
      { content: "same", blocks: JSON.stringify([wake]) },
      { content: "same", blocks: null },
    ]);
    expect(repeatedRowMarks(db, "s", "same")).toBeUndefined();
  });
});

describe("a sub-agent's results wake the chat in a marked row (SUBAGENT-12)", () => {
  const card = { agentId: "c1", name: "scout", turn: 1, status: "completed", partial: false, text: "Report: 3 files" };

  test("the well-formed cards ride on the row, so nobody reads them as the person's words", () => {
    expect(userRowMarks({ subagentResults: [card] })).toEqual([{ kind: "subagent-result", results: [card] }] as never);
  });

  test("a malformed entry is dropped, and none at all marks nothing", () => {
    expect(userRowMarks({ subagentResults: [{ ...card, status: "finished" }, { name: "x" }] })).toBeUndefined();
    expect(userRowMarks({ subagentResults: [] })).toBeUndefined();
  });
});
