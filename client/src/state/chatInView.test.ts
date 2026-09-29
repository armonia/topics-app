/**
 * The chat 'done' mark is decided where it is set: a turn that ends on the
 * chat the person is looking at raises no mark at all. Raising it and clearing
 * it one commit later was enough for the provider's effects to paint +1 on the
 * Dock and the PWA badge and take it back, at every turn end (the verifier's
 * setAppBadge history: 0,1,0,1,0,...).
 *
 * Under bun there is no document, so `isWindowAwake()` answers true: these
 * tests pin the "shown as a focused chat" half. The awake half is the e2e's
 * (`chat-finished-banner.spec.ts`), where the window can be put behind
 * another app.
 *
 * @covers CHAT-DONE-01
 */
import { afterEach, describe, expect, test } from "bun:test";
import { holdChatInView, isChatInFront } from "./chatInView";
import { chatFinishedEdge } from "../lib/notify/chatFinished";

const end = (topicId: string) => ({ type: "stream:end", topicId, completed: true, stopReason: "end_turn" });

const releases: Array<() => void> = [];
afterEach(() => {
  while (releases.length) releases.pop()!();
});

describe("the chat 'done' mark and the chat in front", () => {
  test("five turns that end on the chat in front raise no mark", () => {
    releases.push(holdChatInView("front"));
    const edges = Array.from({ length: 5 }, () => chatFinishedEdge(end("front"), isChatInFront));
    expect(edges).toEqual([null, null, null, null, null]);
  });

  test("a chat that is not in front is marked as before, and a new turn still clears", () => {
    releases.push(holdChatInView("front"));
    expect(chatFinishedEdge(end("behind"), isChatInFront)).toEqual({ op: "mark", topicId: "behind" });
    expect(chatFinishedEdge({ type: "stream:start", topicId: "front" }, isChatInFront)).toEqual({ op: "clear", topicId: "front" });
  });

  test("once the pane lets go, the next turn end marks the chat", () => {
    const release = holdChatInView("front");
    expect(chatFinishedEdge(end("front"), isChatInFront)).toBeNull();
    release();
    release(); // a second release is a no-op, not a negative count
    expect(isChatInFront("front")).toBe(false);
    expect(chatFinishedEdge(end("front"), isChatInFront)).toEqual({ op: "mark", topicId: "front" });
  });

  test("two panes on one chat: it stays in front until both let go", () => {
    const a = holdChatInView("twice");
    const b = holdChatInView("twice");
    a();
    expect(isChatInFront("twice")).toBe(true);
    b();
    expect(isChatInFront("twice")).toBe(false);
  });
});
