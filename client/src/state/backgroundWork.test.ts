/**
 * THE BACKGROUND IS A STATE OF ITS OWN, never a turn in flight.
 *
 * A `background` row of `/api/topics/streaming` says a chat has no turn open
 * but its last turn left an agent, a Bash or a Monitor running. If such a chat
 * entered the streaming sets, `reconcileServerStreams` and the composer would
 * treat it as a reply in progress: the message queued instead of sent, and a
 * ghost turn reopened. So the poll's reading rule keeps it apart, per session
 * for the composer's Stop and per topic for the glyphs, the chat line and the
 * agent list, and the Stop that ends it clears both at once.
 *
 * @covers BGVIS-01, BGVIS-02
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mergeBackgroundWork, projectBackgroundCount, readStreamingSnapshot, type TopicBackgroundWork } from "./backgroundWork";
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

describe("projectBackgroundCount", () => {
  test("counts the chats of that project only", () => {
    const topics = {
      a: { id: "a", projectPath: "/p" },
      b: { id: "b", projectPath: "/p" },
      c: { id: "c", projectPath: "/q" },
    } as unknown as Record<string, Topic>;
    const work = new Map(["a", "c", "gone"].map((id) => [id, { sessionKey: `topic:${id}`, tasks: [], lastSignalAt: 0 }]));
    expect(projectBackgroundCount("/p", topics, work)).toBe(1);
    expect(projectBackgroundCount("/q", topics, work)).toBe(1);
    expect(projectBackgroundCount("/none", topics, work)).toBe(0);
  });

  test("an archived chat does not light the folder: no row, no tab and no agent row would name it", () => {
    // Closing a chat's tab archives it and leaves its background work running,
    // and the status route still reports it. The folder follows the same gate
    // as the agent list (`visibleTopicSignalIds`).
    const topics = {
      a: { id: "a", projectPath: "/p", archived: true },
      b: { id: "b", projectPath: "/p" },
    } as unknown as Record<string, Topic>;
    const work = new Map(["a", "b"].map((id) => [id, { sessionKey: `topic:${id}`, tasks: [], lastSignalAt: 0 }]));
    expect(projectBackgroundCount("/p", topics, work)).toBe(1);
    work.delete("b");
    expect(projectBackgroundCount("/p", topics, work)).toBe(0);
  });
});

describe("the signals store", () => {
  afterEach(() => {
    signalsActions.setBackgroundWork(new Set(), new Map());
    signalsActions.setHydratedStreamTopics(new Set());
  });

  test("the poll writes the session and the topic in one pass, and the streaming sets stay untouched", () => {
    const snap = readStreamingSnapshot([{ topicId: "T", sessionKey: "topic:T", state: "background", tasks: twoTasks, lastSignalAt: 1 }]);
    signalsActions.setHydratedStreamTopics(snap.streamingTopics);
    signalsActions.setBackgroundWork(snap.backgroundSessions, snap.backgroundTopics);
    const st = useSignalsStore.getState();
    expect(st.backgroundWorkSessions.has("topic:T")).toBe(true);
    expect(st.backgroundWorkTopics.get("T")?.tasks).toEqual(twoTasks);
    expect(st.hydratedStreamTopics.has("T")).toBe(false);
    expect(st.liveStreamTopics.has("T")).toBe(false);
  });

  test("the Stop that ended the work clears the session and the topic at once, without the next poll", () => {
    const snap = readStreamingSnapshot([
      { topicId: "T", sessionKey: "topic:T", state: "background", tasks: twoTasks, lastSignalAt: 1 },
      { topicId: "V", sessionKey: "topic:V", state: "background", tasks: [], lastSignalAt: 1 },
    ]);
    signalsActions.setBackgroundWork(snap.backgroundSessions, snap.backgroundTopics);
    signalsActions.dropBackgroundWork("topic:T");
    const st = useSignalsStore.getState();
    expect([...st.backgroundWorkSessions]).toEqual(["topic:V"]);
    expect([...st.backgroundWorkTopics.keys()]).toEqual(["V"]);
  });
});
