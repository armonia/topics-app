import { describe, expect, test } from "bun:test";
import { GLOBAL_BOARD_ID, isTopicRef, proposalStatus, proposalTaskId } from "./master-proposals";

describe("isTopicRef", () => {
  test("real topic ids are topic refs", () => {
    expect(isTopicRef("11111111-1111-4111-8111-111111111111")).toBe(true);
  });
  test("terminal refs are not topic refs", () => {
    expect(isTopicRef("terminal:abc123")).toBe(false);
  });
  test("empty ref is not a topic ref", () => {
    expect(isTopicRef("")).toBe(false);
  });
});

describe("proposalStatus", () => {
  test("completa → done, apri → todo", () => {
    expect(proposalStatus("completa")).toBe("done");
    expect(proposalStatus("apri")).toBe("todo");
  });
});

describe("proposalTaskId", () => {
  test("is stable for the same ref (dedupe key)", () => {
    expect(proposalTaskId("topic-1")).toBe(proposalTaskId("topic-1"));
  });
  test("differs for different refs", () => {
    expect(proposalTaskId("topic-1")).not.toBe(proposalTaskId("topic-2"));
  });
  test("is independent of verb/reason — same card updates in place", () => {
    // The id depends only on the ref, so an APRI later superseded by COMPLETA
    // (with a reworded reason) resolves to the same card id.
    expect(proposalTaskId("terminal:x")).toBe(proposalTaskId("terminal:x"));
  });
  test("is prefixed and bounded in length", () => {
    const id = proposalTaskId("topic-1");
    expect(id.startsWith("mp-")).toBe(true);
    expect(id.length).toBe(3 + 16);
  });
});

describe("GLOBAL_BOARD_ID", () => {
  test("is a stable constant", () => {
    expect(GLOBAL_BOARD_ID).toBe("master-global");
  });
});
