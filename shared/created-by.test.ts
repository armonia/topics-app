/**
 * The created_by grammar and the creator chip read from it.
 * @covers KANBAN-05
 */
import { test, expect } from "bun:test";
import { parseCreatedBy, splitCreatedBy } from "./created-by";
import { creatorChip } from "../client/src/components/Board/createdByLabel";

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

test("the card names who opened it: a named agent or schedule, «you» for a person, nothing without an author", () => {
  const tr = (key: string, p?: Record<string, string | number>) => `${key}|${p?.name ?? ""}`;
  expect(creatorChip({ createdBy: "agent:jarvis" }, tr)?.label).toBe("jarvis");
  expect(creatorChip({ createdBy: "cron:nightly" }, tr)?.label).toBe("board.card.createdByCron|nightly");
  expect(creatorChip({ createdBy: "human" }, tr)?.label).toBe("board.card.createdByMe|");
  expect(creatorChip({ createdBy: "agent:api" }, tr)?.label).toBe("board.card.createdByApi|");
  expect(creatorChip({ createdBy: null }, tr)).toBeNull();
  expect(creatorChip({ createdBy: "garbage" }, tr)).toBeNull();
});
