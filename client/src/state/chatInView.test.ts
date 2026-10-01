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
import { holdSubjectInFront, isSubjectInFront, seeChatFinished, takeChatDoneSeen } from "./chatInView";
import { chatFinishedEdge } from "../lib/notify/chatFinished";
import { signalsActions, useSignalsStore } from "./signals";

const end = (topicId: string) => ({ type: "stream:end", topicId, completed: true, stopReason: "end_turn" });

const releases: Array<() => void> = [];
afterEach(() => {
  while (releases.length) releases.pop()!();
});

describe("the chat 'done' mark and the chat in front", () => {
  test("five turns that end on the chat in front raise no mark", () => {
    releases.push(holdSubjectInFront("front"));
    const edges = Array.from({ length: 5 }, () => chatFinishedEdge(end("front"), isSubjectInFront));
    expect(edges).toEqual([null, null, null, null, null]);
  });

  test("a chat that is not in front is marked as before, and a new turn still clears", () => {
    releases.push(holdSubjectInFront("front"));
    expect(chatFinishedEdge(end("behind"), isSubjectInFront)).toEqual({ op: "mark", topicId: "behind" });
    expect(chatFinishedEdge({ type: "stream:start", topicId: "front" }, isSubjectInFront)).toEqual({ op: "clear", topicId: "front" });
  });

  test("once the pane lets go, the next turn end marks the chat", () => {
    const release = holdSubjectInFront("front");
    expect(chatFinishedEdge(end("front"), isSubjectInFront)).toBeNull();
    release();
    release(); // a second release is a no-op, not a negative count
    expect(isSubjectInFront("front")).toBe(false);
    expect(chatFinishedEdge(end("front"), isSubjectInFront)).toEqual({ op: "mark", topicId: "front" });
  });

  test("two panes on one chat: it stays in front until both let go", () => {
    const a = holdSubjectInFront("twice");
    const b = holdSubjectInFront("twice");
    a();
    expect(isSubjectInFront("twice")).toBe(true);
    b();
    expect(isSubjectInFront("twice")).toBe(false);
  });
});

/**
 * The mark lives per window, and the seen dwell (`useWebSocket`) fires after
 * the pane has already cleared it here: `takeChatDoneSeen` is how the dwell
 * still knows the chat carried one, so the server's seen frame reaches the
 * other windows (CHAT-DONE-01, cross-window).
 */
describe("a 'done' mark seen here, for the seen door", () => {
  test("a look clears the mark and is remembered once", () => {
    signalsActions.markChatFinished("seen-once");
    seeChatFinished("seen-once");
    expect(useSignalsStore.getState().chatFinishedTopics.has("seen-once")).toBe(false);
    expect(takeChatDoneSeen("seen-once")).toBe(true);
    expect(takeChatDoneSeen("seen-once")).toBe(false);
  });

  test("a new turn is not a look: the dwell has nothing to tell", () => {
    signalsActions.markChatFinished("restarted");
    signalsActions.clearChatFinished("restarted");
    expect(takeChatDoneSeen("restarted")).toBe(false);
  });

  test("a look at a chat with no mark tells nothing", () => {
    seeChatFinished("never-marked");
    expect(takeChatDoneSeen("never-marked")).toBe(false);
  });

  test("a mark still on the chat when the dwell fires counts too", () => {
    signalsActions.markChatFinished("still-on");
    expect(takeChatDoneSeen("still-on")).toBe(true);
    signalsActions.clearChatFinished("still-on");
  });
});
