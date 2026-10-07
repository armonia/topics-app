/**
 * Which children and commands are a chat's work NOW (chat-live-work).
 *
 * @covers SUBSTRIP-01
 */
import { describe, expect, test } from "bun:test";
import { liveWorkRows, type CliChildNow, type EndedChildNow, type LiveWorkInput, type NativeChildNow } from "./live-work";

const NOW = Date.parse("2026-10-07T20:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

const cli = (over: Partial<CliChildNow> = {}): CliChildNow => ({
  id: "cli-1", name: "cli", createdAt: ago(10 * MIN), phase: "working", busy: true, reportedAt: null, preview: "", ...over,
});
const native = (over: Partial<NativeChildNow> = {}): NativeChildNow => ({
  id: "nat-1", name: "native", createdAt: ago(10 * MIN), sessionKey: "topic:nat1", phase: "working", preview: "", ...over,
});
const ended = (over: Partial<EndedChildNow> = {}): EndedChildNow => ({
  id: "end-1", name: "ended", createdAt: ago(3 * HOUR), runtime: "topics", sessionKey: "topic:end1",
  endedAt: ago(2 * HOUR), reportedAt: ago(2 * HOUR), preview: "", ...over,
});
const input = (over: Partial<LiveWorkInput> = {}): LiveWorkInput => ({ cli: [], native: [], ended: [], commands: [], ...over });
const ids = (rows: ReturnType<typeof liveWorkRows>) => rows.map((r) => `${r.id}:${r.kind === "agent" ? r.state : "command"}`);

describe("only what works now", () => {
  test("the Prince of Persia chat: three children ended hours ago, one working, one command → two rows", () => {
    const rows = liveWorkRows(input({
      ended: [ended({ id: "e1" }), ended({ id: "e2", runtime: "cli", sessionKey: null }), ended({ id: "e3", endedAt: ago(5 * HOUR) })],
      native: [native({ id: "muse", preview: "Bash: freeagent" })],
      commands: [{ processId: "p1", name: "tick", command: "tick", startedAt: ago(MIN), lastLine: "tick 41", listen: [] }],
    }), NOW);
    expect(ids(rows)).toEqual(["muse:working", "p1:command"]);
    expect(rows[0]).toMatchObject({ preview: "Bash: freeagent", sessionKey: "topic:nat1", runtime: "topics" });
    expect(rows[1]).toMatchObject({ preview: "tick 41", listen: [] });
  });

  test("no children and no commands: no rows", () => {
    expect(liveWorkRows(input(), NOW)).toEqual([]);
  });
});

describe("a child that just ended stays a minute with its check", () => {
  test("a native child ended 10 s ago: ended, gone in 50 s; at 61 s it is gone", () => {
    const rows = liveWorkRows(input({ ended: [ended({ endedAt: ago(10_000) })] }), NOW);
    expect(rows).toEqual([expect.objectContaining({ id: "end-1", state: "ended", endedAt: ago(10_000), goneInMs: 50_000 })]);
    expect(liveWorkRows(input({ ended: [ended({ endedAt: ago(61_000) })] }), NOW)).toEqual([]);
  });

  test("a CLI child ends when its turn was reported, not when its PTY was retired 15 minutes later", () => {
    const retired = ended({ runtime: "cli", sessionKey: null, reportedAt: ago(15 * MIN), endedAt: ago(1_000) });
    expect(liveWorkRows(input({ ended: [retired] }), NOW)).toEqual([]);
    // Stopped in the middle of its turn: the stop reports it.
    const stopped = ended({ runtime: "cli", sessionKey: null, reportedAt: ago(2_000), endedAt: ago(2_000) });
    expect(ids(liveWorkRows(input({ ended: [stopped] }), NOW))).toEqual(["end-1:ended"]);
    // No report on record: its end is all there is.
    const lost = ended({ runtime: "cli", sessionKey: null, reportedAt: null, endedAt: ago(5_000) });
    expect(ids(liveWorkRows(input({ ended: [lost] }), NOW))).toEqual(["end-1:ended"]);
  });

  test("a live CLI child whose turn is over: ended from its report, gone a minute later", () => {
    expect(liveWorkRows(input({ cli: [cli({ phase: "finished", reportedAt: ago(20_000) })] }), NOW))
      .toEqual([expect.objectContaining({ id: "cli-1", state: "ended", goneInMs: 40_000 })]);
    expect(liveWorkRows(input({ cli: [cli({ phase: "finished", reportedAt: ago(2 * MIN) })] }), NOW)).toEqual([]);
  });

  test("a native child whose turn just closed, its row not yet retired: ended now", () => {
    expect(liveWorkRows(input({ native: [native({ phase: "finished" })] }), NOW))
      .toEqual([expect.objectContaining({ id: "nat-1", state: "ended", goneInMs: 60_000 })]);
  });

  test("an end with no date is not shown: it could not say when it leaves", () => {
    expect(liveWorkRows(input({ ended: [ended({ endedAt: null })] }), NOW)).toEqual([]);
    expect(liveWorkRows(input({ cli: [cli({ phase: "finished", reportedAt: null })] }), NOW)).toEqual([]);
  });

  test("listed live and ended at once: live", () => {
    const rows = liveWorkRows(input({ native: [native({ id: "x" })], ended: [ended({ id: "x", endedAt: ago(1_000) })] }), NOW);
    expect(ids(rows)).toEqual(["x:working"]);
  });
});

describe("what a live child is doing", () => {
  test("waiting for its prompt, working, and a CLI child before the first look (its PTY says)", () => {
    expect(ids(liveWorkRows(input({ cli: [cli({ phase: "waiting-prompt" })] }), NOW))).toEqual(["cli-1:waiting"]);
    expect(ids(liveWorkRows(input({ native: [native({ phase: "waiting-prompt" })] }), NOW))).toEqual(["nat-1:waiting"]);
    expect(ids(liveWorkRows(input({ native: [native({ phase: null })] }), NOW))).toEqual(["nat-1:working"]);
    expect(ids(liveWorkRows(input({ cli: [cli({ phase: null, busy: true })] }), NOW))).toEqual(["cli-1:working"]);
    expect(ids(liveWorkRows(input({ cli: [cli({ phase: null, busy: false })] }), NOW))).toEqual(["cli-1:waiting"]);
  });
});

describe("the order", () => {
  test("children by their start, ended ones keeping their place, then the commands by theirs", () => {
    const rows = liveWorkRows(input({
      cli: [cli({ id: "c", createdAt: ago(5 * MIN) })],
      native: [native({ id: "a", createdAt: ago(20 * MIN) })],
      ended: [ended({ id: "b", createdAt: ago(10 * MIN), endedAt: ago(1_000) })],
      commands: [
        { processId: "p2", name: "b", command: "b", startedAt: ago(MIN), lastLine: "", listen: [] },
        { processId: "p1", name: "a", command: "a", startedAt: ago(2 * MIN), lastLine: "", listen: [{ host: "127.0.0.1", port: 8781 }] },
      ],
    }), NOW);
    expect(ids(rows)).toEqual(["a:working", "b:ended", "c:working", "p1:command", "p2:command"]);
    expect(rows[3]).toMatchObject({ listen: [{ host: "127.0.0.1", port: 8781 }] });
  });
});
