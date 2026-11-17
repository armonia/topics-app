/**
 * The `stream:action` feed: one light global frame per CHANGE of what a topic's
 * agent is doing, derived from the stream frames the server already sends.
 *
 * @covers STATUS-VISUAL-01k
 */
import { describe, expect, test } from "bun:test";
import { createStreamActionFeed, type ObservedFrame, type StreamActionPayload } from "./stream-action-feed";

const T = "topic-1";
const SK = "sk-1";

function setup() {
  const sent: StreamActionPayload[] = [];
  const feed = createStreamActionFeed((p) => sent.push(p));
  const see = (type: string, extra: Partial<ObservedFrame> = {}) =>
    feed.observe({ type, topicId: T, sessionKey: SK, ...extra });
  const tool = (name: string, extra: Partial<ObservedFrame> = {}) =>
    see("stream:tool_call", { toolCall: { name }, ...extra });
  return { sent, feed, see, tool };
}

describe("createStreamActionFeed", () => {
  test("the same tool announced three times is one frame", () => {
    const { sent, tool } = setup();
    tool("Bash");
    tool("Bash");
    tool("Bash");
    expect(sent).toEqual([{ topicId: T, sessionKey: SK, action: "run" }]);
  });

  test("a run of content chunks is one `write`", () => {
    const { sent, see } = setup();
    for (let i = 0; i < 50; i++) see("stream:content_chunk");
    expect(sent.map((s) => s.action)).toEqual(["write"]);
  });

  test("a change of action says the new one", () => {
    const { sent, see, tool } = setup();
    see("stream:thinking_start");
    tool("Read");
    tool("Edit");
    see("stream:content_chunk");
    expect(sent.map((s) => s.action)).toEqual(["think", "read", "edit", "write"]);
  });

  test("a granted permission goes back to the tool that asked", () => {
    const { sent, see, tool } = setup();
    tool("Edit");
    see("stream:tool_permission_required");
    see("stream:tool_permission_resolved");
    expect(sent.map((s) => s.action)).toEqual(["edit", "wait", "edit"]);
  });

  test("a permission resolved with no tool before it falls back to think", () => {
    const { sent, see } = setup();
    see("stream:tool_permission_resolved");
    expect(sent.map((s) => s.action)).toEqual(["think"]);
  });

  test("the end clears the topic without a frame, and the next turn says its action again", () => {
    const { sent, feed, see, tool } = setup();
    tool("Bash");
    see("stream:end");
    expect(sent).toHaveLength(1);
    expect(feed.size()).toBe(0);
    tool("Bash");
    expect(sent.map((s) => s.action)).toEqual(["run", "run"]);
  });

  test("an error says `error` once, then forgets the topic", () => {
    const { sent, feed, see, tool } = setup();
    tool("Bash");
    see("stream:error");
    expect(sent.map((s) => s.action)).toEqual(["run", "error"]);
    expect(feed.size()).toBe(0);
    // A turn after the failure starts from nothing: a granted permission has no tool to resume.
    see("stream:tool_permission_resolved");
    expect(sent.map((s) => s.action)).toEqual(["run", "error", "think"]);
  });

  test("an error as the first frame is still said", () => {
    const { sent, see } = setup();
    see("stream:error");
    expect(sent.map((s) => s.action)).toEqual(["error"]);
  });

  test("late frames of a closed turn are ignored", () => {
    const { sent, tool, see } = setup();
    tool("Bash", { late: true });
    see("stream:content_chunk", { late: true });
    see("stream:error", { late: true });
    expect(sent).toEqual([]);
  });

  test("stream:start, usage and every non-stream frame say nothing", () => {
    const { sent, feed, see } = setup();
    see("stream:start");
    see("stream:usage");
    see("stream:alive");
    see("stream:tool_update");
    see("stream:action");
    see("topic:updated");
    expect(sent).toEqual([]);
    expect(feed.size()).toBe(0);
  });

  test("a frame with no topic or no session is skipped", () => {
    const { sent, feed } = setup();
    feed.observe({ type: "stream:content_chunk", sessionKey: SK });
    feed.observe({ type: "stream:content_chunk", topicId: T });
    expect(sent).toEqual([]);
  });

  test("topics are independent, and state exists only for turns in flight", () => {
    const { sent, feed } = setup();
    feed.observe({ type: "stream:content_chunk", topicId: "a", sessionKey: "sa" });
    feed.observe({ type: "stream:content_chunk", topicId: "b", sessionKey: "sb" });
    feed.observe({ type: "stream:content_chunk", topicId: "a", sessionKey: "sa" });
    expect(sent.map((s) => s.topicId)).toEqual(["a", "b"]);
    expect(feed.size()).toBe(2);
    feed.observe({ type: "stream:end", topicId: "a", sessionKey: "sa" });
    feed.observe({ type: "stream:error", topicId: "b", sessionKey: "sb" });
    expect(feed.size()).toBe(0);
  });

  test("a Codex command named after itself is a run, not a generic tool", () => {
    const { sent, see } = setup();
    see("stream:tool_call", { toolCall: { name: "pwd", args: { command: "pwd" } } });
    expect(sent.map((s) => s.action)).toEqual(["run"]);
  });
  test("current() lists each open turn with its session and last action", () => {
    const { feed } = setup();
    expect(feed.current()).toEqual([]);
    feed.observe({ type: "stream:content_chunk", topicId: "a", sessionKey: "sa" });
    feed.observe({ type: "stream:tool_call", topicId: "b", sessionKey: "sb", toolCall: { name: "Edit" } });
    feed.observe({ type: "stream:content_chunk", topicId: "a", sessionKey: "sa" });
    feed.observe({ type: "stream:thinking_start", topicId: "a", sessionKey: "sa" });
    expect(feed.current()).toEqual([
      { topicId: "a", sessionKey: "sa", action: "think" },
      { topicId: "b", sessionKey: "sb", action: "edit" },
    ]);
  });

  test("current() forgets a turn that ended or failed", () => {
    const { feed } = setup();
    feed.observe({ type: "stream:content_chunk", topicId: "a", sessionKey: "sa" });
    feed.observe({ type: "stream:content_chunk", topicId: "b", sessionKey: "sb" });
    feed.observe({ type: "stream:end", topicId: "a", sessionKey: "sa" });
    feed.observe({ type: "stream:error", topicId: "b", sessionKey: "sb" });
    expect(feed.current()).toEqual([]);
  });

  test("an end that carries only its session (topic deleted mid-turn) still closes the entry", () => {
    const { feed } = setup();
    feed.observe({ type: "stream:content_chunk", topicId: "gone", sessionKey: "s-gone" });
    feed.observe({ type: "stream:content_chunk", topicId: "kept", sessionKey: "s-kept" });
    // The server could not resolve the topic of this end: no topicId on the frame.
    feed.observe({ type: "stream:end", sessionKey: "s-gone" });
    expect(feed.size()).toBe(1);
    expect(feed.current().map((p) => p.topicId)).toEqual(["kept"]);
    feed.observe({ type: "stream:error", sessionKey: "s-kept" });
    expect(feed.size()).toBe(0);
  });

  test("a sessionless end, or a topicless frame that is not an end, changes nothing", () => {
    const { feed } = setup();
    feed.observe({ type: "stream:content_chunk", topicId: "a", sessionKey: "sa" });
    feed.observe({ type: "stream:end" });
    feed.observe({ type: "stream:content_chunk", sessionKey: "sa" });
    feed.observe({ type: "stream:end", sessionKey: "other" });
    expect(feed.size()).toBe(1);
  });
});
