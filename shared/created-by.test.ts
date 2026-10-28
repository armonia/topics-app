import { test, expect } from "bun:test";
import { parseCreatedBy, splitCreatedBy } from "./created-by";
import { openedByLabel } from "../client/src/components/Board/createdByLabel";

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

test("the card says who opened it, and says nothing when nobody is known", () => {
  const tr = (key: string, p?: Record<string, string | number>) => `${key}|${p?.name ?? ""}`;
  expect(openedByLabel("human", tr)).toBe("board.card.createdByHuman|");
  expect(openedByLabel("agent:jarvis", tr)).toBe("board.card.createdByAgent|jarvis");
  expect(openedByLabel("cron:nightly", tr)).toBe("board.card.createdByCron|nightly");
  expect(openedByLabel(null, tr)).toBeNull();
  expect(openedByLabel("garbage", tr)).toBeNull();
});
