/**
 * Tests for `resumeStateAfter` - the rule that decides whether the chat is
 * being resumed BY THE SERVER right now.
 *
 * What it protects, in one line: while the boot resends the message on its
 * own, the composer must not keep offering Retry, because Retry resends the
 * same message and the chat already has a turn running.
 *
 * The "no" cases are the ones worth the file. A resume announced on the wrong
 * chat lights a banner under a composer nobody resumed; a resume that never
 * ends leaves that banner on top of a working answer forever.
 *
 * @covers CHAT-INT-02
 */
import { describe, test, expect } from "bun:test";
import { resumeStateAfter } from "./useServerResume";
import type { WSMessage } from "../types";

const KEY = "session-under-test";
const frame = (f: Record<string, unknown>) => f as unknown as WSMessage;

describe("resumeStateAfter", () => {
  test("a stream the server resumed turns it on", () => {
    expect(resumeStateAfter(false, frame({
      type: "stream:start", sessionKey: KEY, messageId: "m1", resumedBy: "server",
    }), KEY)).toBe(true);
  });

  test("an ordinary stream does not: a turn somebody asked for is not a resume", () => {
    expect(resumeStateAfter(false, frame({
      type: "stream:start", sessionKey: KEY, messageId: "m1",
    }), KEY)).toBe(false);
  });

  test("a new ordinary stream clears a resume left on", () => {
    expect(resumeStateAfter(true, frame({
      type: "stream:start", sessionKey: KEY, messageId: "m2",
    }), KEY)).toBe(false);
  });

  test("the first token closes it: the answer is now its own proof", () => {
    expect(resumeStateAfter(true, frame({
      type: "stream:content_chunk", sessionKey: KEY, content: "Il",
    }), KEY)).toBe(false);
    expect(resumeStateAfter(true, frame({
      type: "stream:thinking_chunk", sessionKey: KEY, content: "hm",
    }), KEY)).toBe(false);
  });

  test("the end closes it too, however it ended: a failed resume goes back to the banner", () => {
    expect(resumeStateAfter(true, frame({
      type: "stream:end", sessionKey: KEY, stopCause: "server-shutdown",
    }), KEY)).toBe(false);
    expect(resumeStateAfter(true, frame({ type: "stream:error", sessionKey: KEY }), KEY)).toBe(false);
  });

  test("another chat's frames say nothing about this one", () => {
    expect(resumeStateAfter(false, frame({
      type: "stream:start", sessionKey: "elsewhere", messageId: "m1", resumedBy: "server",
    }), KEY)).toBe(false);
    expect(resumeStateAfter(true, frame({
      type: "stream:end", sessionKey: "elsewhere",
    }), KEY)).toBe(true);
  });

  test("frames of another family leave the answer where it was", () => {
    expect(resumeStateAfter(true, frame({ type: "topic:updated", topicId: "t1" }), KEY)).toBe(true);
    expect(resumeStateAfter(false, frame({ type: "topic:updated", topicId: "t1" }), KEY)).toBe(false);
  });
});
