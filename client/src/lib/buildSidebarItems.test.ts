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
import { buildSidebarItems, groupSidebarItems } from "./buildSidebarItems";
import type { TerminalSessionInfo, Topic } from "../types";

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

// ── Pinning (Fissati) — pinnedIds gate escapes ────────────────────────────────
//
// Pinned rows survive tab close: `pinnedIds` acts as an `||` escape at every
// tab-driven visibility gate (mirrors the orchestratorManaged precedent).
// The builder only MARKS pinned items (`pinned: true`); the sidebar partitions
// at render time, so the notification-first sort contract stays intact for the
// unpinned body.

const topic = (id: string, name: string, extra: Partial<Topic> = {}): Topic => ({
  id,
  name,
  slug: name.toLowerCase(),
  parentId: null,
  links: [],
  sessionKey: `topic:${id}`,
  color: "#0066cc",
  icon: "",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  archived: false,
  ...extra,
});

describe("buildSidebarItems — pinning (Fissati)", () => {
  test("a pinned CLOSED non-archived standalone chat renders with pinned:true (no tab, zero notifications)", () => {
    const items = buildSidebarItems({
      ...base,
      topics: { a1: topic("a1", "Alpha") },
      terminalSessions: [],
      openPanels: [],
      projectOpenPanes: {},
      pinnedIds: new Set(["a1"]),
    });
    const row = items.find((i) => i.id === "a1");
    expect(row).toBeTruthy();
    expect(row!.pinned).toBe(true);
  });

  test("a pinned ARCHIVED standalone chat renders with showArchived=false", () => {
    const items = buildSidebarItems({
      ...base,
      topics: { a1: topic("a1", "Alpha", { archived: true }) },
      terminalSessions: [],
      openPanels: [],
      projectOpenPanes: {},
      pinnedIds: new Set(["a1"]),
    });
    const row = items.find((i) => i.id === "a1");
    expect(row).toBeTruthy();
    expect(row!.pinned).toBe(true);
    expect(row!.archived).toBe(true);
  });

  test("a pinned CLOSED project-child chat renders (archived or not) and keeps the parent project row alive", () => {
    // Neither the project pane nor any child tab is open — without the pin the
    // whole project row would be gated out.
    const items = buildSidebarItems({
      ...base,
      workspaceProjects: [],
      topics: {
        c1: topic("c1", "Closed child", { projectPath: PP }),
        c2: topic("c2", "Archived child", { projectPath: PP, archived: true }),
      },
      terminalSessions: [],
      openPanels: [],
      projectOpenPanes: {},
      pinnedIds: new Set(["c1", "c2"]),
    });
    const project = items.find((i) => i.id === `project:${PP}`);
    expect(project).toBeTruthy();
    // The project row itself is NOT pinned — it lives via children.length > 0.
    expect(project!.pinned).toBeUndefined();
    const childIds = (project!.children ?? []).map((c) => c.id);
    expect(childIds).toContain("c1");
    expect(childIds).toContain("c2");
    expect(project!.children!.find((c) => c.id === "c1")!.pinned).toBe(true);
    expect(project!.children!.find((c) => c.id === "c2")!.pinned).toBe(true);
  });

  test("a pinned project with zero children, no tab and no workspace entry still renders (projectPaths seeding)", () => {
    const lonely = "/work/lonely";
    const items = buildSidebarItems({
      ...base,
      workspaceProjects: [],
      topics: {},
      terminalSessions: [],
      openPanels: [],
      projectOpenPanes: {},
      pinnedIds: new Set([`project:${lonely}`]),
    });
    const project = items.find((i) => i.id === `project:${lonely}`);
    expect(project).toBeTruthy();
    expect(project!.pinned).toBe(true);
    expect(project!.children).toEqual([]);
  });

  test("regression lock: unpinned items keep the exact gate behaviour (all four gates)", () => {
    const opts = {
      ...base,
      workspaceProjects: [],
      topics: {
        s1: topic("s1", "Standalone closed"),
        s2: topic("s2", "Standalone archived", { archived: true }),
        p1: topic("p1", "Project closed", { projectPath: PP }),
        p2: topic("p2", "Project archived", { projectPath: PP, archived: true }),
      },
      terminalSessions: [],
      openPanels: [],
      projectOpenPanes: {},
    };
    const without = buildSidebarItems(opts);
    const withEmpty = buildSidebarItems({ ...opts, pinnedIds: new Set<string>() });
    // Nothing shows: no tabs, no notifications, nothing pinned…
    expect(without).toEqual([]);
    // …and an EMPTY pinnedIds is byte-identical to not passing it.
    expect(withEmpty).toEqual(without);
  });

  test("builder output order is unchanged by pinning (partition is render-side)", () => {
    const opts = {
      ...base,
      workspaceProjects: [],
      topics: {
        a1: topic("a1", "Alpha", { updatedAt: new Date(1000).toISOString() }),
        b1: topic("b1", "Beta", { updatedAt: new Date(2000).toISOString() }),
      },
      terminalSessions: [],
      openPanels: ["a1", "b1"],
      projectOpenPanes: {},
    };
    const unpinnedOrder = buildSidebarItems(opts).map((i) => i.id);
    const pinnedOrder = buildSidebarItems({ ...opts, pinnedIds: new Set(["a1"]) }).map((i) => i.id);
    expect(pinnedOrder).toEqual(unpinnedOrder);
  });

  test("a pinned standalone terminal survives its tab closing (no open tab, pinned:true)", () => {
    // cwd outside PP → standalone terminal (§4 gate). Without the pin it would
    // be gated out (no open pane); the `terminal:<id>` pin key is the escape.
    const items = buildSidebarItems({
      ...base,
      workspaceProjects: [],
      topics: {},
      terminalSessions: [term("s1", "/elsewhere")],
      openPanels: [],
      projectOpenPanes: {},
      pinnedIds: new Set(["terminal:s1"]),
    });
    const row = items.find((i) => i.id === "terminal:s1");
    expect(row).toBeTruthy();
    expect(row!.type).toBe("terminal");
    expect(row!.pinned).toBe(true);
  });

  test("a pinned project terminal survives its tab closing as a project child (pinned:true)", () => {
    const items = buildSidebarItems({
      ...base,
      terminalSessions: [term("s1", PP)],
      openPanels: [projectPaneId], // project pane open, but NO terminal pane
      projectOpenPanes: {},
      pinnedIds: new Set(["terminal:s1"]),
    });
    const project = items.find((i) => i.id === `project:${PP}`);
    expect(project).toBeTruthy();
    const term1 = project!.children!.find((c) => c.id === "terminal:s1");
    expect(term1).toBeTruthy();
    expect(term1!.pinned).toBe(true);
  });

  test("an UNpinned standalone terminal with no open tab stays hidden (escape is pin-gated)", () => {
    const items = buildSidebarItems({
      ...base,
      workspaceProjects: [],
      topics: {},
      terminalSessions: [term("s1", "/elsewhere")],
      openPanels: [],
      projectOpenPanes: {},
    });
    expect(items.find((i) => i.id === "terminal:s1")).toBeUndefined();
  });

  test("groupSidebarItems never sees a 'pinned' type — pinned items bucket by their REAL type", () => {
    const items = buildSidebarItems({
      ...base,
      workspaceProjects: [],
      topics: { a1: topic("a1", "Alpha") },
      terminalSessions: [],
      openPanels: [],
      projectOpenPanes: {},
      pinnedIds: new Set(["a1", `project:${PP}`]),
    });
    const groups = groupSidebarItems(items);
    // Only the four canonical buckets exist…
    expect(Object.keys(groups).sort()).toEqual(["browser", "chat", "project", "terminal"]);
    // …and pinned items land in their real-type bucket, flagged pinned.
    expect(groups.chat.map((i) => i.id)).toEqual(["a1"]);
    expect(groups.chat[0].pinned).toBe(true);
    expect(groups.project.map((i) => i.id)).toEqual([`project:${PP}`]);
  });
});
