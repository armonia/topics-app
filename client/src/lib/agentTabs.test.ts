/**
 * Preview tabs and agent chats: who opens a tab and who replaces it.
 * @covers TAB-ANTEPRIMA-01 (allow-italian: requirement id)
 */
import { describe, test, expect } from "bun:test";
import { isAgentOwnedTopic, planPreviewChatTab, shouldParkAgentTabs, markAgentTabsParked } from "./agentTabs";
import type { Pane, PaneGroup } from "../types";

const chat = (id: string, preview: boolean): Pane => ({ id, type: 'chat', topicId: id, title: id, preview });

describe("isAgentOwnedTopic", () => {
  test("a chat Attilio opened is his", () => {
    expect(isAgentOwnedTopic({ parentId: null, mcpPolicy: null })).toBe(false);
  });
  test("Jarvis's channel chat, a sub-agent and a dispatched card are the agents'", () => {
    expect(isAgentOwnedTopic({ parentId: 'jarvis-canali', mcpPolicy: null })).toBe(true);
    expect(isAgentOwnedTopic({ parentId: null, subagentOf: 'topic:x', mcpPolicy: null })).toBe(true);
    expect(isAgentOwnedTopic({ parentId: null, mcpPolicy: 'bridge-only' })).toBe(true);
  });
  test("unknown topic is not hidden", () => {
    expect(isAgentOwnedTopic(undefined)).toBe(false);
  });
});

describe("planPreviewChatTab", () => {
  const g: PaneGroup = { id: 'g', paneIds: ['a', 'b'], activePaneId: 'a', type: 'chat' };
  test("open B while A is provisional: B takes A's slot, bar does not grow", () => {
    const plan = planPreviewChatTab(g, [chat('a', true), chat('b', false)], 'c');
    expect(plan).toEqual({ kind: 'replace-preview', replacedPaneId: 'a', paneIds: ['c', 'b'] });
  });
  test("after interaction (nothing provisional) the next open adds a tab", () => {
    const plan = planPreviewChatTab(g, [chat('a', false), chat('b', false)], 'c');
    expect(plan).toEqual({ kind: 'append', paneIds: ['a', 'b', 'c'] });
  });
});

describe("one-time parking of agent tabs", () => {
  test("runs once per project", () => {
    const m = new Map<string, string>();
    const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
    expect(shouldParkAgentTabs('/p', st)).toBe(true);
    markAgentTabsParked('/p', st);
    expect(shouldParkAgentTabs('/p', st)).toBe(false);
    expect(shouldParkAgentTabs('/q', st)).toBe(true);
  });
});
