/**
 * @covers CMD-10
 */
import { afterEach, describe, expect, test } from "bun:test";
import { askSideQuestion, runSideQuestionFork, SideQuestionError } from "./sideQuestion";
import { __resetMessageStore, __messageStoreDebug, getSessionMessagesFromStore, updateMessages } from "../../state/messageStore";
import { __resetServerTurns, __serverTurnSubscriberCount, noteServerTurn } from "../../state/serverTurn";

const sideSessionKey = "topic:side";
const mainSessionKey = "topic:main";

afterEach(() => {
  __resetMessageStore();
  __resetServerTurns();
});

function addSideMessage(message: { role: string; content: string; partial?: boolean }) {
  updateMessages((previous) => ({
    ...previous,
    [sideSessionKey]: [...(previous[sideSessionKey] ?? []), message as never],
  }));
}

function openTurn(asOf = 1) {
  noteServerTurn(sideSessionKey, { boot: "boot-a", asOf, turnId: 1, open: true });
}

function closeTurn(asOf = 2) {
  noteServerTurn(sideSessionKey, { boot: "boot-a", asOf, turnId: 1, open: false });
}

describe("/btw session isolation", () => {
  test("waits for the accepted turn to close before reading its answer", async () => {
    let settled = false;
    let markSendStarted!: () => void;
    const sendStarted = new Promise<void>((resolve) => { markSendStarted = resolve; });
    const answerPromise = askSideQuestion({
      mainSessionKey,
      sideSessionKey,
      question: "side prompt",
      loadHistory: async () => {},
      sendMessage: async () => { markSendStarted(); return true; },
      getSessionMessages: getSessionMessagesFromStore,
    }).then((answer) => { settled = true; return answer; });

    await sendStarted;
    expect(__serverTurnSubscriberCount(sideSessionKey)).toBe(1);
    openTurn();
    addSideMessage({ role: "assistant", content: "side answer", partial: true });
    addSideMessage({ role: "assistant", content: "side answer" });
    await Promise.resolve();
    expect(settled).toBe(false);
    closeTurn();

    expect(await answerPromise).toBe("side answer");
    expect(__serverTurnSubscriberCount(sideSessionKey)).toBe(0);
    expect(__messageStoreDebug().iscritti).toBe(0);
  });

  test("a turn whose open was never heard still ends the wait when it closes", async () => {
    let markSendStarted!: () => void;
    const sendStarted = new Promise<void>((resolve) => { markSendStarted = resolve; });
    const answerPromise = askSideQuestion({
      mainSessionKey,
      sideSessionKey,
      question: "side prompt",
      loadHistory: async () => {},
      sendMessage: async () => { markSendStarted(); return true; },
      getSessionMessages: getSessionMessagesFromStore,
    });
    await sendStarted;
    addSideMessage({ role: "assistant", content: "side answer" });
    closeTurn();
    expect(await answerPromise).toBe("side answer");
    expect(__serverTurnSubscriberCount(sideSessionKey)).toBe(0);
  });

  test("returns no-answer when the turn closes without assistant text", async () => {
    let markSendStarted!: () => void;
    const sendStarted = new Promise<void>((resolve) => { markSendStarted = resolve; });
    const answerPromise = askSideQuestion({
      mainSessionKey,
      sideSessionKey,
      question: "side prompt",
      loadHistory: async () => {},
      sendMessage: async () => { markSendStarted(); return true; },
      getSessionMessages: getSessionMessagesFromStore,
    });
    await sendStarted;
    openTurn();
    closeTurn();
    await expect(answerPromise).rejects.toBeInstanceOf(SideQuestionError);
    await expect(answerPromise).rejects.toMatchObject({ code: "no-answer" });
    expect(__serverTurnSubscriberCount(sideSessionKey)).toBe(0);
    expect(__messageStoreDebug().iscritti).toBe(0);
  });

  test("closing during the wait detaches both listeners", async () => {
    const controller = new AbortController();
    let closeCalls = 0;
    let removedSession: string | undefined;
    let markSendStarted!: () => void;
    const sendStarted = new Promise<void>((resolve) => { markSendStarted = resolve; });
    const answerPromise = runSideQuestionFork({
      createFork: async () => ({ id: "fork-1", sessionKey: sideSessionKey }),
      ask: (fork) => askSideQuestion({
        mainSessionKey,
        sideSessionKey: fork.sessionKey,
        question: "side prompt",
        loadHistory: async () => {},
        sendMessage: async () => { markSendStarted(); return true; },
        getSessionMessages: getSessionMessagesFromStore,
        signal: controller.signal,
      }),
      closeFork: async () => { closeCalls++; },
      onClosed: (sessionKey) => { removedSession = sessionKey; },
    });
    await sendStarted;
    openTurn();
    controller.abort();
    await expect(answerPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(__serverTurnSubscriberCount(sideSessionKey)).toBe(0);
    expect(__messageStoreDebug().iscritti).toBe(0);
    expect(closeCalls).toBe(1);
    expect(removedSession).toBe(sideSessionKey);
  });

  test("refuses to use the main session as the side fork", async () => {
    await expect(askSideQuestion({
      mainSessionKey,
      sideSessionKey: mainSessionKey,
      question: "side prompt",
      loadHistory: async () => {},
      sendMessage: async () => true,
      getSessionMessages: getSessionMessagesFromStore,
    })).rejects.toThrow("forked session");
  });
});
