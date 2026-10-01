/**
 * The one seen event and the subject it is about.
 *
 * `focusedSubjectOf` decides WHICH pane is in front from the window's focus,
 * so every input that moves the focus (tab, click inside, keyboard, row)
 * reaches the same subject. `seeSubject` is the event: it must clear every
 * mark of that subject at once, or the surfaces that read different marks
 * disagree again. The dwell around it is the e2e's
 * (`tests/e2e/seen-on-any-focus.spec.ts`).
 *
 * @covers SEEN-ANY-FOCUS-01
 * @covers SEEN-ANY-FOCUS-02
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { focusedSubjectOf, hasUnseenMark, seeSubject, subjectOfPaneId } from "./paneSeen";
import { signalsActions, useSignalsStore } from "./signals";
import { takeChatDoneSeen } from "./chatInView";
import { useUnseenNotificationsStore } from "./notificationUnseen";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  useUnseenNotificationsStore.getState().setKeys([]);
});

describe("the subject in front", () => {
  test("a top-level chat, a project chat and a terminal name their subject", () => {
    expect(subjectOfPaneId("2f6c1a9e-topic")).toBe("2f6c1a9e-topic");
    expect(subjectOfPaneId("chat:2f6c1a9e-topic")).toBe("2f6c1a9e-topic");
    expect(subjectOfPaneId("terminal:sess-1")).toBe("sess-1");
  });

  test("panes that carry no mark have no subject", () => {
    for (const id of ["__board__", "browser:ctx", "file:/a/b.ts", "draft:x", "project:%2Fa", "", null, undefined]) {
      expect(subjectOfPaneId(id)).toBeNull();
    }
  });

  test("a focused project window means its focused inner pane, and only that project's", () => {
    const panes = { "/work/a": "terminal:in-a", "/work/b": "chat:in-b" };
    expect(focusedSubjectOf(`project:${encodeURIComponent("/work/a")}`, panes)).toBe("in-a");
    expect(focusedSubjectOf(`project:${encodeURIComponent("/work/b")}`, panes)).toBe("in-b");
    expect(focusedSubjectOf(`project:${encodeURIComponent("/work/c")}`, panes)).toBeNull();
    expect(focusedSubjectOf(null, panes)).toBeNull();
    expect(focusedSubjectOf("terminal:top", panes)).toBe("top");
  });
});

describe("the seen event", () => {
  test("clears the terminal mark, the chat mark and sets the seen flag, in one call", () => {
    const posted: string[] = [];
    globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      posted.push(String(init?.body ?? ""));
      return Promise.resolve(new Response("{}"));
    }) as unknown as typeof fetch;
    signalsActions.markTerminalFinished("seen-term");
    signalsActions.markChatFinished("seen-chat");

    seeSubject("seen-term");
    seeSubject("seen-chat");

    const s = useSignalsStore.getState();
    expect(s.terminalFinishedIds.has("seen-term")).toBe(false);
    expect(s.chatFinishedTopics.has("seen-chat")).toBe(false);
    expect(s.seenSubjects.has("seen-term")).toBe(true);
    expect(s.seenSubjects.has("seen-chat")).toBe(true);
    // The terminal's history rows are told too, the chat's goes through the seen door.
    expect(posted.some((b) => b.includes("seen-term"))).toBe(true);
    expect(takeChatDoneSeen("seen-chat")).toBe(true);
    expect(hasUnseenMark(s, "seen-term")).toBe(false);
    expect(hasUnseenMark(s, "seen-chat")).toBe(false);
  });

  test("a new mark on a seen subject makes it unseen again, so the dwell re-arms", () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response("{}"))) as unknown as typeof fetch;
    seeSubject("again");
    expect(hasUnseenMark(useSignalsStore.getState(), "again")).toBe(false);
    signalsActions.markTerminalFinished("again");
    expect(hasUnseenMark(useSignalsStore.getState(), "again")).toBe(true);
    seeSubject("again");
    expect(hasUnseenMark(useSignalsStore.getState(), "again")).toBe(false);
  });

  test("a terminal's unseen history row is a mark even with no finished mark, and the seen event tells the registry", () => {
    // A claude-code terminal driven by hooks never gets the finished mark
    // (its phase drives attention), but its banner leaves a row grouped under
    // `terminal:<id>` on the bell and the Dock. Already seen once, the subject
    // has only that row left to clear.
    const posted: string[] = [];
    globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      posted.push(String(init?.body ?? ""));
      return Promise.resolve(new Response("{}"));
    }) as unknown as typeof fetch;
    seeSubject("hooked-term");
    posted.length = 0;
    useUnseenNotificationsStore.getState().setKeys(["terminal:hooked-term"]);
    const keys = useUnseenNotificationsStore.getState().keys;
    expect(hasUnseenMark(useSignalsStore.getState(), "hooked-term", keys)).toBe(true);
    // Another subject's row is not this one's mark.
    expect(hasUnseenMark(useSignalsStore.getState(), "other-term-xyz-seen", keys)).toBe(true);
    seeSubject("other-term-xyz-seen");
    expect(hasUnseenMark(useSignalsStore.getState(), "other-term-xyz-seen", keys)).toBe(false);
    posted.length = 0;

    seeSubject("hooked-term");
    expect(posted.map((b) => JSON.parse(b) as unknown)).toContainEqual({ targetKind: "terminal", targetId: "hooked-term" });
  });

  test("a subject with no row and no mark tells the registry nothing", () => {
    const posted: string[] = [];
    globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      posted.push(String(init?.body ?? ""));
      return Promise.resolve(new Response("{}"));
    }) as unknown as typeof fetch;
    seeSubject("quiet-subject");
    expect(posted).toEqual([]);
  });
});
