/**
 * Which cards a chat is really waiting on: the waiting line and the sidebar
 * read the same predicate, so a card nobody works must not keep either up.
 *
 * @covers BGVIS-04
 */
import { describe, expect, test } from "bun:test";
import { isAwaitedCard, openCardsOf } from "./taskCardState";
import type { BoardTask } from "./board";

const card = (over: Partial<BoardTask>): BoardTask =>
  ({ id: "c1", status: "in_progress", dispatchState: null, openerTopicId: "t1", ...over }) as BoardTask;

describe("isAwaitedCard", () => {
  test("a card moved to in_progress by hand, with no agent on it, is not waited on", () => {
    // The live case of 17/11: status in_progress, dispatch_state NULL, five hours.
    expect(isAwaitedCard(card({ status: "in_progress", dispatchState: null }))).toBe(false);
  });

  test.each(["queued", "starting", "working"])("a card an agent has (%s) is waited on", (dispatchState) => {
    expect(isAwaitedCard(card({ status: "in_progress", dispatchState }))).toBe(true);
  });

  test("a card in the dispatcher's queue is waited on", () => {
    expect(isAwaitedCard(card({ status: "todo", dispatchState: null }))).toBe(true);
  });

  test("a finished, failed or in-review card is not", () => {
    expect(isAwaitedCard(card({ status: "done" }))).toBe(false);
    expect(isAwaitedCard(card({ status: "review" }))).toBe(false);
    expect(isAwaitedCard(card({ status: "in_progress", dispatchState: "failed" }))).toBe(false);
  });
});

describe("openCardsOf", () => {
  test("the line and the sidebar list only the cards somebody works", () => {
    const list = [
      card({ id: "manual", status: "in_progress", dispatchState: null }),
      card({ id: "running", status: "in_progress", dispatchState: "working" }),
      card({ id: "other-chat", status: "in_progress", dispatchState: "working", openerTopicId: "t2" }),
    ];
    expect(openCardsOf(list, "t1").map((c) => c.id)).toEqual(["running"]);
  });

  test("a card the chat sent back by id follows the same rule", () => {
    const list = [card({ id: "sent", status: "in_progress", dispatchState: null, openerTopicId: "other" })];
    expect(openCardsOf(list, "t1", new Set(["sent"]))).toEqual([]);
  });
});
