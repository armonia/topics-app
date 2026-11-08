/**
 * Agent sessions: the criterion (an agent's home folder), the grouping by
 * agent with sub-agents under their parent, the state at work, and the rule
 * that agent homes leave the sidebar's project list.
 *
 * @covers TOPIC-02
 */
import { describe, test, expect } from "bun:test";
import { agentOfPath, groupAgentSessions, workingAgentCount } from "./agentSessions";
import { buildSidebarItems } from "./buildSidebarItems";
import type { Topic } from "../types";

const H = "/Users/me";
const topic = (id: string, projectPath: string, extra: Partial<Topic> = {}): Topic =>
  ({
    id, name: id, slug: id, parentId: null, links: [], sessionKey: `topic:${id}`, color: "", icon: "",
    createdAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T10:00:00.000Z", archived: false, projectPath, ...extra,
  }) as Topic;

describe("agentOfPath", () => {
  test("reads the agent from the folder", () => {
    expect(agentOfPath(`${H}/.openclaw`)).toBe("jarvis");
    expect(agentOfPath(`${H}/.openclaw/workspace`)).toBe("jarvis");
    expect(agentOfPath(`${H}/.claude/jarvis/home`)).toBe("jarvis");
    expect(agentOfPath(`${H}/.openclaw/workspace-gtm`)).toBe("gtm");
    expect(agentOfPath(`${H}/.claude/jarvis/home/workspace-gtm/sub`)).toBe("gtm");
  });
  test("a normal project is not an agent's", () => {
    expect(agentOfPath(`${H}/Projects/quadra`)).toBeNull();
    expect(agentOfPath(`${H}/.openclawish`)).toBeNull();
    expect(agentOfPath(undefined)).toBeNull();
  });
});

describe("groupAgentSessions", () => {
  const topics = {
    a: topic("a", `${H}/.openclaw`, { updatedAt: "2026-11-08T09:00:00.000Z" }),
    b: topic("b", `${H}/.claude/jarvis/home`),
    c: topic("c", `${H}/.openclaw/workspace-gtm`),
    sub: topic("sub", `${H}/.openclaw`, { subagentOf: "topic:a" }),
    old: topic("old", `${H}/.openclaw`, { archived: true }),
    p: topic("p", `${H}/Projects/quadra`),
  };

  test("groups by agent, sub-agents under the parent, archived and projects out", () => {
    const groups = groupAgentSessions(topics, new Set(), new Set());
    expect(groups.map((g) => [g.id, g.name])).toEqual([["jarvis", "Jarvis"], ["gtm", "Visione"]]);
    const jarvis = groups[0];
    expect(jarvis.total).toBe(3);
    expect(jarvis.sessions.map((s) => s.topic.id)).toEqual(["a", "b"]);
    expect(jarvis.sessions[0].children.map((s) => s.topic.id)).toEqual(["sub"]);
    expect(workingAgentCount(groups)).toBe(0);
  });

  test("state: working and waiting rise the session and the agent to the top", () => {
    const groups = groupAgentSessions(topics, new Set(["c"]), new Set(["b"]));
    expect(groups.map((g) => g.id)).toEqual(["jarvis", "gtm"]);
    expect(groups[0].state).toBe("waiting");
    expect(groups[0].sessions[0].topic.id).toBe("b");
    expect(groups[1].state).toBe("working");
    expect(workingAgentCount(groups)).toBe(1);
  });

  test("a sub-agent at work counts for its parent's agent", () => {
    const groups = groupAgentSessions(topics, new Set(["sub"]), new Set());
    expect(groups[0].id).toBe("jarvis");
    expect(groups[0].working).toBe(1);
    expect(workingAgentCount(groups)).toBe(1);
  });
});

describe("buildSidebarItems leaves agent homes out of the project list", () => {
  test("no project row for an agent's folder, even open or in the workspace", () => {
    const topics = { a: topic("a", `${H}/.openclaw`), p: topic("p", `${H}/Projects/quadra`) };
    const items = buildSidebarItems({
      topics,
      workspaceProjects: [`${H}/.openclaw`, `${H}/Projects/quadra`],
      browserContexts: [],
      showArchived: false,
      openPanels: [`project:${encodeURIComponent(`${H}/Projects/quadra`)}`, `project:${encodeURIComponent(`${H}/.claude/jarvis/home`)}`],
      pinnedIds: new Set([`project:${H}/.openclaw/workspace-gtm`]),
    });
    const projects = items.filter((i) => i.type === "project").map((i) => i.projectPath);
    expect(projects).toEqual([`${H}/Projects/quadra`]);
  });

  test("an agent session open as a tab still shows, as a loose chat", () => {
    const topics = { a: topic("a", `${H}/.openclaw/workspace-gtm`) };
    const items = buildSidebarItems({ topics, browserContexts: [], showArchived: false, openPanels: ["a"] });
    expect(items.some((i) => i.type === "project")).toBe(false);
    expect(items.some((i) => i.id === "a")).toBe(true);
  });
});
