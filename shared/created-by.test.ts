/**
 * The created_by grammar and the creator chip read from it.
 * @covers KANBAN-05
 */
import { test, expect } from "bun:test";
import { parseCreatedBy, splitCreatedBy } from "./created-by";
import { cardOwner } from "../client/src/components/Board/cardOrigin";

test("parseCreatedBy accepts the three shapes and nothing else", () => {
  for (const ok of ["human", "agent:jarvis", "cron:scheduled-card", "agent:a.b_c-1"]) expect(parseCreatedBy(ok)).toBe(ok);
  for (const bad of ["", "Human", "agent:", "agent: x", "robot:x", "agent:x y", "agent:;drop", null, undefined, 3]) {
    expect(parseCreatedBy(bad)).toBeNull();
  }
});

test("splitCreatedBy returns kind and name", () => {
  expect(splitCreatedBy("human")).toEqual({ kind: "human", name: null });
  expect(splitCreatedBy("agent:jarvis")).toEqual({ kind: "agent", name: "jarvis" });
  expect(splitCreatedBy("cron:nightly")).toEqual({ kind: "cron", name: "nightly" });
  expect(splitCreatedBy(null)).toBeNull();
});

test("whose card it is follows who opened it: a named agent, a schedule, the person, the board", () => {
  const owner = (createdBy: string | null) => cardOwner({ createdBy } as Parameters<typeof cardOwner>[0], null).key;
  expect(owner("agent:jarvis")).toBe("agent:jarvis");
  expect(owner("agent:zeno")).toBe("agent:zeno");
  expect(owner("cron:nightly")).toBe("scheduled");
  expect(owner("human")).toBe("me");
  expect(owner("agent:api")).toBe("board");
  expect(owner(null)).toBe("board");
  expect(owner("garbage")).toBe("board");
});
