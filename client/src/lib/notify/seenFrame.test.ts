/**
 * What a `notification:seen` frame switches off in a window: the unseen dots
 * of the history rows (the subjects' lit state is the attention frame's).
 *
 * @covers NOTIF-ONE-01
 */
import { describe, expect, test } from "bun:test";
import { frameCoversSubject, rowSeenByFrame } from "./seenFrame";

describe("frameCoversSubject", () => {
  test("a frame with subjects covers exactly those", () => {
    expect(frameCoversSubject({ subjects: ["topic:a"] }, "topic:a")).toBe(true);
    expect(frameCoversSubject({ subjects: ["topic:a"] }, "topic:b")).toBe(false);
  });

  test("a frame that names nothing covers nothing", () => {
    expect(frameCoversSubject({}, "topic:a")).toBe(false);
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
