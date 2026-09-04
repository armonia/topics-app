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
import { describe, expect, test } from "bun:test";
import { userRowMarks } from "./user-row-marks";

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
