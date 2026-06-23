/**
 * buildSidebarItems — sidebar inclusion contract.
 *
 * The sidebar is TAB-DRIVEN: a row shows only while its pane is open (or, for
 * chats, while it has a pending notification). The regression this pins:
 * project terminals used to be listed unconditionally as "active resources",
 * so closing a terminal tab left its sidebar row behind. They are now gated on
 * an open tab exactly like standalone terminals and project chats, so closing
 * the tab removes the row.
 */
import { describe, test, expect } from "bun:test";
import { buildSidebarItems } from "./buildSidebarItems";
import type { TerminalSessionInfo } from "../types";

const PP = "/work/app";
const projectPaneId = `project:${encodeURIComponent(PP)}`;

const term = (id: string, cwd: string): TerminalSessionInfo =>
  ({
    id,
    name: "Claude Code",
    createdAt: new Date(0).toISOString(),
    cwd,
    command: "claude",
    clients: 1,
    type: "claude-code",
  });

// Keep the project itself visible (project pane open as a top-level tab) so the
// assertions isolate the terminal-child gating from project-level visibility.
const base = {
  topics: {},
  workspaceProjects: [PP],
  browserContexts: [],
  unreadData: {},
  showArchived: false,
};

function projectChildren(items: ReturnType<typeof buildSidebarItems>) {
  const project = items.find((i) => i.type === "project");
  return project?.children ?? [];
}

describe("buildSidebarItems — project terminal gating", () => {
  test("a running terminal with NO open tab is hidden (closing the tab removes the row)", () => {
    const items = buildSidebarItems({
      ...base,
      terminalSessions: [term("s1", PP)],
      openPanels: [projectPaneId],
      projectOpenPanes: {}, // no open terminal pane inside the project
    });
    const termChildren = projectChildren(items).filter((c) => c.type === "terminal");
    expect(termChildren).toHaveLength(0);
  });

  test("a terminal with an open pane inside the project window shows", () => {
    const items = buildSidebarItems({
      ...base,
      terminalSessions: [term("s1", PP)],
      openPanels: [projectPaneId],
      projectOpenPanes: { [PP]: ["terminal:s1"] },
    });
    const termChildren = projectChildren(items).filter((c) => c.type === "terminal");
    expect(termChildren).toHaveLength(1);
    expect(termChildren[0].id).toBe("terminal:s1");
  });

  test("a terminal open as a top-level tab shows", () => {
    const items = buildSidebarItems({
      ...base,
      terminalSessions: [term("s1", PP)],
      openPanels: [projectPaneId, "terminal:s1"],
      projectOpenPanes: {},
    });
    const termChildren = projectChildren(items).filter((c) => c.type === "terminal");
    expect(termChildren).toHaveLength(1);
  });

  test("only the open terminal shows when several sessions run in the same project", () => {
    const items = buildSidebarItems({
      ...base,
      terminalSessions: [term("s1", PP), term("s2", PP), term("s3", PP)],
      openPanels: [projectPaneId],
      projectOpenPanes: { [PP]: ["terminal:s2"] },
    });
    const termChildren = projectChildren(items).filter((c) => c.type === "terminal");
    expect(termChildren.map((c) => c.id)).toEqual(["terminal:s2"]);
  });
});

describe("buildSidebarItems — sub-agent nesting", () => {
  const child = (id: string, parentSessionKey: string, cwd: string): TerminalSessionInfo =>
    ({ ...term(id, cwd), parentSessionKey });

  test("a sub-agent nests under its parent terminal (and not as a flat row)", () => {
    const items = buildSidebarItems({
      ...base,
      // Parent terminal open as a top-level tab; child has NO open tab.
      terminalSessions: [term("parent", "/home/me"), child("kid", "parent", "/home/me")],
      openPanels: ["parent" /* parent pane id below */],
      projectOpenPanes: {},
    });
    // The parent standalone terminal row carries the child nested under it…
    const parentRow = items.find((i) => i.id === "terminal:parent");
    expect(parentRow).toBeTruthy();
    expect((parentRow!.subAgents ?? []).map((s) => s.id)).toEqual(["terminal:kid"]);
    // …and the child is NOT emitted as its own flat row.
    expect(items.some((i) => i.id === "terminal:kid")).toBe(false);
  });

  test("an orchestrator stays visible even with its own tab closed (has sub-agents)", () => {
    const items = buildSidebarItems({
      ...base,
      terminalSessions: [term("parent", "/home/me"), child("kid", "parent", "/home/me")],
      openPanels: [], // parent's own pane is closed
      projectOpenPanes: {},
    });
    const parentRow = items.find((i) => i.id === "terminal:parent");
    expect(parentRow).toBeTruthy();
    expect((parentRow!.subAgents ?? []).map((s) => s.id)).toEqual(["terminal:kid"]);
  });

  test("a sub-agent whose parent is not a terminal (chat orchestrator) is not hidden", () => {
    const items = buildSidebarItems({
      ...base,
      // parentSessionKey points at a chat session, not a terminal id.
      terminalSessions: [child("kid", "topic:abcd1234", "/home/me")],
      openPanels: [],
      projectOpenPanes: {},
    });
    // Falls through to the flat standalone path; visible because it's a sub-agent.
    expect(items.some((i) => i.id === "terminal:kid")).toBe(true);
  });
});
