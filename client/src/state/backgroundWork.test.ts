/**
 * THE BACKGROUND IS A STATE OF ITS OWN, never a turn in flight.
 *
 * A `background` row of `/api/topics/streaming` says a chat has no turn open
 * but its last turn left an agent, a Bash or a Monitor running. If such a chat
 * entered the streaming sets, `reconcileServerStreams` and the composer would
 * treat it as a reply in progress: the message queued instead of sent, and a
 * ghost turn reopened. So the poll's reading rule keeps it apart. Whether a
 * chat waits on background work is the attention state's now (the glyphs, the
 * Stop, the agent list, notifications-redesign); the poll keeps only the
 * detail the line under the transcript names.
 *
 * A later turn does not end that work: the turn row names it, and the chat
 * keeps it on the per-topic map while the composer's Stop stays the turn's.
 *
 * @covers BGVIS-01, BGVIS-02, BGVIS-05
 */
import { afterEach, describe, expect, test } from "bun:test";
import { composerStopsTasks, composerStopsWork, mergeBackgroundWork, readStreamingSnapshot, type TopicBackgroundWork } from "./backgroundWork";
import { projectBackgroundCount } from "./attentionRollups";
import { signalsActions, useSignalsStore } from "./signals";
import type { Topic } from "../types";

const twoTasks = [
  { type: "local_agent", description: "Verifica build" },
  { type: "local_bash", description: "Monitor deploy" },
];

describe("readStreamingSnapshot", () => {
  test("a background row goes to its own set and map, never into the streaming ones", () => {
    const snap = readStreamingSnapshot([
      { topicId: "T", sessionKey: "topic:T", state: "background", tasks: twoTasks, lastSignalAt: 1234 },
      { topicId: "U", sessionKey: "topic:U", state: "streaming" },
      { topicId: "W", sessionKey: "topic:W", state: "waiting" },
    ]);
    expect([...snap.streamingTopics]).toEqual(["U", "W"]);
    expect([...snap.streamingSessions]).toEqual(["topic:U", "topic:W"]);
    expect([...snap.waitingTopics]).toEqual(["W"]);
    expect([...snap.backgroundSessions]).toEqual(["topic:T"]);
    expect(snap.backgroundTopics.get("T")).toEqual({ sessionKey: "topic:T", tasks: twoTasks, lastSignalAt: 1234 });
  });

  test("a turn row naming the work an earlier turn left running keeps it on the topic, not on the session", () => {
    const snap = readStreamingSnapshot([
      { topicId: "T", sessionKey: "topic:T", state: "streaming", background: { tasks: twoTasks, lastSignalAt: 77 } },
      { topicId: "W", sessionKey: "topic:W", state: "waiting", background: { tasks: [], lastSignalAt: 5 } },
    ]);
    expect([...snap.streamingTopics]).toEqual(["T", "W"]);
    expect([...snap.streamingSessions]).toEqual(["topic:T", "topic:W"]);
    expect(snap.backgroundTopics.get("T")).toEqual({ sessionKey: "topic:T", tasks: twoTasks, lastSignalAt: 77 });
    // No task named: nothing to show.
    expect(snap.backgroundTopics.has("W")).toBe(false);
    // With a turn open the composer's Stop is the turn's.
    expect(snap.backgroundSessions.size).toBe(0);
  });

  test("a chat running only run_command processes names them, and offers no composer Stop that would stop nothing (BGVIS-07)", () => {
    const command = { type: "command", description: "CMDJOB", processId: "p-1", wakes: true, startedAt: 5 };
    const snap = readStreamingSnapshot([
      { topicId: "C", sessionKey: "topic:C", state: "background", tasks: [command], lastSignalAt: 0 },
      { topicId: "M", sessionKey: "topic:M", state: "background", tasks: [command, twoTasks[0]], lastSignalAt: 9 },
    ]);
    expect(snap.backgroundTopics.get("C")).toEqual({ sessionKey: "topic:C", tasks: [command], lastSignalAt: 0 });
    expect([...snap.backgroundSessions]).toEqual(["topic:M"]);
    expect(composerStopsWork([])).toBe(true);
    expect(composerStopsWork([command])).toBe(false);
  });

  test("a row from a server that does not name the tasks reads as none named", () => {
    const snap = readStreamingSnapshot([{ topicId: "T", sessionKey: "topic:T", state: "background" }]);
    expect(snap.backgroundTopics.get("T")).toEqual({ sessionKey: "topic:T", tasks: [], lastSignalAt: 0 });
  });
});

describe("mergeBackgroundWork", () => {
  const work = (lastSignalAt: number): TopicBackgroundWork => ({ sessionKey: "topic:T", tasks: [...twoTasks], lastSignalAt });

  test("an unchanged poll keeps the same map and the same entries, so no row re-renders", () => {
    const prev = new Map([["T", work(5)]]);
    expect(mergeBackgroundWork(prev, new Map([["T", work(5)]]))).toBe(prev);
  });

  test("news replaces only the entry that changed", () => {
    const kept = work(5);
    const prev = new Map([["T", work(5)], ["V", kept]]);
    const next = mergeBackgroundWork(prev, new Map([["T", work(9)], ["V", { ...kept, tasks: [...kept.tasks] }]]));
    expect(next).not.toBe(prev);
    expect(next.get("T")?.lastSignalAt).toBe(9);
    expect(next.get("V")).toBe(kept);
  });
});

describe("projectBackgroundCount: the closed folder's grey glyph, from the attention state", () => {
  const bgRow = (subject: string) => ({
    subject, state: "background" as const, reason: null, outcome: null, detail: null, since: "", epoch: 0, seenEpoch: 0,
    lit: false, unread: 0, turnUnseen: false, lastTurnAt: null, background: [{ id: "b", kind: "bash", label: "x", startedAt: "" }],
  });

  test("counts the children of the project waiting on background work", () => {
    const topics = {
      a: { id: "a", projectPath: "/p" },
      b: { id: "b", projectPath: "/p" },
      c: { id: "c", projectPath: "/q" },
    } as unknown as Record<string, Topic>;
    const rows = new Map(["topic:a", "topic:c", "topic:gone"].map((s) => [s, bgRow(s)]));
    expect(projectBackgroundCount(rows, "/p", topics, [])).toBe(1);
    expect(projectBackgroundCount(rows, "/q", topics, [])).toBe(1);
    expect(projectBackgroundCount(rows, "/none", topics, [])).toBe(0);
  });

  test("an archived chat does not light the folder: no row, no tab and no agent row would name it", () => {
    const topics = {
      a: { id: "a", projectPath: "/p", archived: true },
      b: { id: "b", projectPath: "/p" },
    } as unknown as Record<string, Topic>;
    const rows = new Map(["topic:a", "topic:b"].map((s) => [s, bgRow(s)]));
    expect(projectBackgroundCount(rows, "/p", topics, [])).toBe(1);
    rows.delete("topic:b");
    expect(projectBackgroundCount(rows, "/p", topics, [])).toBe(0);
  });
});

describe("the signals store keeps only the poll's DETAIL", () => {
  afterEach(() => {
    signalsActions.setBackgroundDetail(new Map());
    signalsActions.setHydratedStreamTopics(new Set());
  });

  test("the poll writes the line's detail per topic, and the streaming sets stay untouched", () => {
    const snap = readStreamingSnapshot([{ topicId: "T", sessionKey: "topic:T", state: "background", tasks: twoTasks, lastSignalAt: 1 }]);
    signalsActions.setHydratedStreamTopics(snap.streamingTopics);
    signalsActions.setBackgroundDetail(snap.backgroundTopics);
    const st = useSignalsStore.getState();
    expect(st.backgroundWorkTopics.get("T")?.tasks).toEqual(twoTasks);
    expect(st.hydratedStreamTopics.has("T")).toBe(false);
    expect(st.liveStreamTopics.has("T")).toBe(false);
  });
});

describe("composerStopsTasks: the Stop on the attention state's tasks", () => {
  test("offered while one task is the CLI's own; a run_command alone or no task offers none", () => {
    expect(composerStopsTasks([{ kind: "agent" }])).toBe(true);
    expect(composerStopsTasks([{ kind: "command" }, { kind: "bash" }])).toBe(true);
    expect(composerStopsTasks([{ kind: "command" }])).toBe(false);
    expect(composerStopsTasks([])).toBe(false);
  });
});
