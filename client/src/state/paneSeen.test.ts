/**
 * The one seen event and the subject it is about (notifications-redesign,
 * tasks.md 3.6).
 *
 * `focusedSubjectOf` decides WHICH pane is in front from the window's focus,
 * so every input that moves the focus (tab, click inside, keyboard, row)
 * reaches the same attention subject. `seeSubject` is the event: it sends the
 * epoch and the turn this window shows to the server's seen door, and applies
 * them here at once. The dwell around it is the e2e's
 * (`tests/e2e/seen-on-any-focus.spec.ts`).
 *
 * @covers SEEN-ANY-FOCUS-01
 * @covers ATTN-06
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { focusedSubjectOf, seeSubject, subjectOfPaneId } from "./paneSeen";
import { attentionActions, attentionOf, useAttentionStore } from "./attention";
import type { AttentionSnapshot } from "../../../shared/attention";

const realFetch = globalThis.fetch;
beforeEach(() => attentionActions.reset());
afterEach(() => { globalThis.fetch = realFetch; });

function finished(subject: string, epoch: number, at: string): AttentionSnapshot {
  return {
    subject, state: "finished", reason: null, outcome: "done", detail: null, since: at,
    epoch, seenEpoch: epoch - 1, lit: true, unread: 2, turnUnseen: true, lastTurnAt: at, background: [],
  };
}

describe("the subject in front", () => {
  test("a top-level chat, a project chat and a terminal name their attention subject", () => {
    expect(subjectOfPaneId("2f6c1a9e-topic")).toBe("topic:2f6c1a9e-topic");
    expect(subjectOfPaneId("chat:2f6c1a9e-topic")).toBe("topic:2f6c1a9e-topic");
    expect(subjectOfPaneId("terminal:sess-1")).toBe("terminal:sess-1");
  });

  test("panes that carry no attention have no subject", () => {
    for (const id of ["__board__", "browser:ctx", "file:/a/b.ts", "draft:x", "project:%2Fa", "", null, undefined]) {
      expect(subjectOfPaneId(id)).toBeNull();
    }
  });

  test("a focused project window means its focused inner pane, and only that project's", () => {
    const panes = { "/work/a": "terminal:in-a", "/work/b": "chat:in-b" };
    expect(focusedSubjectOf(`project:${encodeURIComponent("/work/a")}`, panes)).toBe("terminal:in-a");
    expect(focusedSubjectOf(`project:${encodeURIComponent("/work/b")}`, panes)).toBe("topic:in-b");
    expect(focusedSubjectOf(`project:${encodeURIComponent("/work/c")}`, panes)).toBeNull();
    expect(focusedSubjectOf(null, panes)).toBeNull();
    expect(focusedSubjectOf("terminal:top", panes)).toBe("terminal:top");
  });
});

describe("the seen event", () => {
  test("posts the epoch and the turn shown to the seen door, and switches the subject off here at once", () => {
    const posted: { url: string; body: string }[] = [];
    globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      posted.push({ url: String(url), body: String(init?.body ?? "") });
      return Promise.resolve(new Response("{}"));
    }) as unknown as typeof fetch;
    attentionActions.applyFrame({ type: "attention:init", rows: [finished("terminal:seen-term", 3, "2026-10-03T10:00:00.000Z")] });

    seeSubject("terminal:seen-term");

    expect(attentionOf(useAttentionStore.getState().rows, "terminal:seen-term").lit).toBe(false);
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toContain("/api/attention/seen");
    expect(JSON.parse(posted[0].body)).toEqual({ items: [{ subject: "terminal:seen-term", epoch: 3, turnAt: "2026-10-03T10:00:00.000Z" }] });
  });

  test("a subject with nothing in the store sends nothing", () => {
    let calls = 0;
    globalThis.fetch = mock(() => { calls++; return Promise.resolve(new Response("{}")); }) as unknown as typeof fetch;
    seeSubject("topic:unknown");
    expect(calls).toBe(0);
  });
});
