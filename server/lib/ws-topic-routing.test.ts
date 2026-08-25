/**
 * @covers WIRE-04
 */
import { describe, test, expect } from "bun:test";
import { clientReceivesTopicDelta } from "./ws-topic-routing";

describe("clientReceivesTopicDelta", () => {
  test("undeclared client (no open-set) receives everything — never starved", () => {
    expect(clientReceivesTopicDelta({ focusedTopicId: null }, "t1")).toBe(true);
    expect(clientReceivesTopicDelta({ focusedTopicId: "other" }, "t1")).toBe(true);
  });

  test("declared client receives a topic it has open (even when focused elsewhere)", () => {
    const state = { openTopicIds: new Set(["t1", "t2"]), focusedTopicId: "t2" };
    expect(clientReceivesTopicDelta(state, "t1")).toBe(true); // background tab still streams
    expect(clientReceivesTopicDelta(state, "t2")).toBe(true);
  });

  test("declared client does NOT receive a topic it doesn't have open", () => {
    const state = { openTopicIds: new Set(["t1"]), focusedTopicId: "t1" };
    expect(clientReceivesTopicDelta(state, "t3")).toBe(false);
  });

  test("focused topic is honoured even if not in the open-set (race fallback)", () => {
    const state = { openTopicIds: new Set<string>(), focusedTopicId: "t9" };
    expect(clientReceivesTopicDelta(state, "t9")).toBe(true);
    expect(clientReceivesTopicDelta(state, "t1")).toBe(false);
  });

  test("declared-empty client with no focus receives nothing", () => {
    const state = { openTopicIds: new Set<string>(), focusedTopicId: null };
    expect(clientReceivesTopicDelta(state, "t1")).toBe(false);
  });
});
