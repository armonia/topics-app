/**
 * What a `notification:seen` frame switches off in a window: the in-memory
 * marks (terminal finished, chat done) and the unseen dots of the history rows.
 *
 * @covers NOTIF-ONE-01
 */
import { describe, expect, test } from "bun:test";
import { frameCoversSubject, marksClearedBy, rowSeenByFrame, terminalSubject, topicSubject } from "./seenFrame";

describe("frameCoversSubject", () => {
  test("a frame with subjects covers exactly those", () => {
    expect(frameCoversSubject({ subjects: ["topic:a"] }, "topic:a")).toBe(true);
    expect(frameCoversSubject({ subjects: ["topic:a"] }, "topic:b")).toBe(false);
  });

  test("a frame that names nothing covers nothing", () => {
    expect(frameCoversSubject({}, "topic:a")).toBe(false);
  });
});

describe("marksClearedBy", () => {
  test("terminal marks use the terminal group key the rows are born with", () => {
    const finished = new Set(["s1", "s2"]);
    expect(marksClearedBy({ subjects: [terminalSubject("s1")] }, terminalSubject, finished)).toEqual(["s1"]);
  });

  test("chat done marks use the topic group key, and never match a terminal of the same id", () => {
    const done = new Set(["x"]);
    expect(marksClearedBy({ subjects: [topicSubject("x")] }, topicSubject, done)).toEqual(["x"]);
    expect(marksClearedBy({ subjects: [terminalSubject("x")] }, topicSubject, done)).toEqual([]);
  });
});

describe("rowSeenByFrame", () => {
  test("only the rows of the named subjects lose their dot", () => {
    expect(rowSeenByFrame({ subjects: ["topic:a"] }, "topic:a")).toBe(true);
    expect(rowSeenByFrame({ subjects: ["topic:a"] }, "topic:b")).toBe(false);
  });

  test("a row with no group is named by its own id, as the server keys it", () => {
    expect(rowSeenByFrame({ subjects: ["row-1"] }, "row-1")).toBe(true);
    expect(rowSeenByFrame({ subjects: ["topic:a"] }, "row-1")).toBe(false);
  });

  test("a legacy frame (no subjects) is the whole list seen, as before", () => {
    expect(rowSeenByFrame({}, "topic:a")).toBe(true);
    expect(rowSeenByFrame({}, "row-1")).toBe(true);
  });
});
