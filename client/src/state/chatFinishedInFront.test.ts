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
import { holdChatInView, isChatInFront, signalsActions, useSignalsStore } from "./signals";

const marked = (id: string): boolean => useSignalsStore.getState().chatFinishedTopics.has(id);

const releases: Array<() => void> = [];
afterEach(() => {
  while (releases.length) releases.pop()!();
  for (const id of ["front", "behind", "twice"]) signalsActions.clearChatFinished(id);
});

describe("the chat 'done' mark and the chat in front", () => {
  test("a turn that ends on the chat in front raises no mark, not even for a commit", () => {
    releases.push(holdChatInView("front"));
    const seen: boolean[] = [];
    const unsubscribe = useSignalsStore.subscribe((s) => seen.push(s.chatFinishedTopics.has("front")));
    for (let i = 0; i < 5; i++) signalsActions.markChatFinished("front");
    unsubscribe();
    expect(marked("front")).toBe(false);
    // No store write at all: nothing a subscriber (the Dock effect) could paint.
    expect(seen).toEqual([]);
  });

  test("a chat that is not in front is marked as before", () => {
    releases.push(holdChatInView("front"));
    signalsActions.markChatFinished("behind");
    expect(marked("behind")).toBe(true);
    expect(isChatInFront("behind")).toBe(false);
  });

  test("once the pane lets go, the next turn end marks the chat", () => {
    const release = holdChatInView("front");
    signalsActions.markChatFinished("front");
    expect(marked("front")).toBe(false);
    release();
    release(); // a second release is a no-op, not a negative count
    expect(isChatInFront("front")).toBe(false);
    signalsActions.markChatFinished("front");
    expect(marked("front")).toBe(true);
  });

  test("two panes on one chat: it stays in front until both let go", () => {
    const a = holdChatInView("twice");
    const b = holdChatInView("twice");
    a();
    expect(isChatInFront("twice")).toBe(true);
    signalsActions.markChatFinished("twice");
    expect(marked("twice")).toBe(false);
    b();
    signalsActions.markChatFinished("twice");
    expect(marked("twice")).toBe(true);
  });
});
