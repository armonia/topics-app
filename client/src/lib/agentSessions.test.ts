/**
 * Agent sessions: the criterion (an agent's home folder), the grouping by
 * agent with sub-agents under their parent, the state at work, and the rule
 * that agent homes leave the sidebar's project list.
 *
 * @covers TOPIC-02
 */
import { describe, test, expect } from "bun:test";
import { agentOfPath, agentSessionName, agentTotals, groupAgentSessions, isErrorText } from "./agentSessions";
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
    expect(agentTotals(groups)).toEqual({ working: 0, waiting: 0 });
  });

  test("state: working and waiting rise the session and the agent to the top", () => {
    const groups = groupAgentSessions(topics, new Set(["c"]), new Set(["b"]));
    expect(groups.map((g) => g.id)).toEqual(["jarvis", "gtm"]);
    expect(groups[0].state).toBe("waiting");
    expect(groups[0].sessions[0].topic.id).toBe("b");
    expect(groups[1].state).toBe("working");
    expect(agentTotals(groups)).toEqual({ working: 1, waiting: 1 });
  });

  test("a sub-agent at work counts for its parent's agent", () => {
    const groups = groupAgentSessions(topics, new Set(["sub"]), new Set());
    expect(groups[0].id).toBe("jarvis");
    expect(groups[0].working).toBe(1);
    expect(agentTotals(groups).working).toBe(1);
  });
});

describe("group order and errors", () => {
  test("waiting first, then working, then the rest; errors counted per agent", () => {
    const topics = {
      j: topic("j", `${H}/.openclaw`),
      v: topic("v", `${H}/.openclaw/workspace-gtm`),
      x: topic("x", `${H}/.openclaw/workspace-ops`),
    };
    const groups = groupAgentSessions(topics, new Set(["x"]), new Set(["v"]), new Set(["j"]));
    expect(groups.map((g) => g.id)).toEqual(["gtm", "ops", "jarvis"]);
    expect(groups[2].errors).toBe(1);
    expect(groups[2].sessions[0].error).toBe(true);
    expect(groups[1].name).toBe("ops");
  });
  test("a provider failure is an error, a normal reply is not", () => {
    expect(isErrorText('API 400: {"type":"error"}')).toBe(true);
    expect(isErrorText("⚠ API Error: overloaded")).toBe(true);
    expect(isErrorText("Fatto, PR aperta")).toBe(false);
  });
});

describe("agentSessionName", () => {
  const titles = { "1000000000000000001": "#canale-prova", "100000000000000000@g.us": "Gruppo di prova" };
  test("raw channel ids take the channel title; cli gets words; the rest stays", () => {
    expect(agentSessionName("Gruppo 1000000000000000001", titles, "Jarvis da terminale")).toBe("#canale-prova");
    expect(agentSessionName("WhatsApp, gruppo 100000000000000000@g.us", titles, "T")).toBe("Gruppo di prova");
    expect(agentSessionName("Gruppo 999", titles, "T")).toBe("Gruppo 999");
    expect(agentSessionName("cli", titles, "Jarvis da terminale")).toBe("Jarvis da terminale");
    expect(agentSessionName("WhatsApp, cli", titles, "Jarvis da terminale")).toBe("Jarvis da terminale");
    expect(agentSessionName("#lotto-siti", titles, "T")).toBe("#lotto-siti");
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

  test("an agent session open as a tab, pinned or lit does NOT show in the normal list", () => {
    const topics = {
      a: topic("a", `${H}/.openclaw/workspace-gtm`),
      sub: topic("sub", `${H}/Projects/quadra`, { subagentOf: "topic:a" }),
      n: topic("n", `${H}/Projects/quadra`),
    };
    const items = buildSidebarItems({
      topics, browserContexts: [], showArchived: false,
      openPanels: ["a", "sub", "n"], pinnedIds: new Set(["a"]),
    });
    const all = JSON.stringify(items);
    expect(all).not.toContain('"id":"a"');
    expect(all).not.toContain('"id":"sub"');
    expect(all).toContain('"id":"n"');
  });
});
