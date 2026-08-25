/**
 * buildSidebarItems — sidebar inclusion contract.
 *
 * The sidebar is TAB-DRIVEN: a row shows only while its pane is open (or, for
 * chats, while it has a pending notification). The regression this pins:
 * project terminals used to be listed unconditionally as "active resources",
 * so closing a terminal tab left its sidebar row behind. They are now gated on
 * an open tab exactly like standalone terminals and project chats, so closing
 * the tab removes the row.
 *
 * @covers TOPIC-02
 */
import { describe, test, expect } from "bun:test";
import {
  buildSidebarItems,
  groupSidebarItemsBySpace,
  sidebarItemPaneId,
  type SidebarItem,
} from "./buildSidebarItems";
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

  test("a sub-agent whose parent is an UNKNOWN key falls through to a flat row", () => {
    const items = buildSidebarItems({
      ...base,
      // parentSessionKey points at neither a terminal id nor a known topic.
      terminalSessions: [child("kid", "topic:abcd1234", "/home/me")],
      openPanels: [],
      projectOpenPanes: {},
    });
    // Falls through to the flat standalone path; visible because it's a sub-agent.
    expect(items.some((i) => i.id === "terminal:kid")).toBe(true);
  });

  test("a sub-agent nests under its CHAT orchestrator parent (not as a flat row)", () => {
    const items = buildSidebarItems({
      ...base,
      // The chat topic's sessionKey is `topic:orch` (see topic() helper below).
      topics: { orch: topic("orch", "Orchestrator chat") },
      terminalSessions: [child("kid", "topic:orch", "/home/me")],
      openPanels: ["orch"], // chat tab open
      projectOpenPanes: {},
    });
    const chatRow = items.find((i) => i.id === "orch");
    expect(chatRow).toBeTruthy();
    expect((chatRow!.subAgents ?? []).map((s) => s.id)).toEqual(["terminal:kid"]);
    // …and the child is NOT emitted as its own flat row.
    expect(items.some((i) => i.id === "terminal:kid")).toBe(false);
  });

  test("a chat orchestrator with a live sub-agent stays visible with its tab closed", () => {
    const items = buildSidebarItems({
      ...base,
      topics: { orch: topic("orch", "Orchestrator chat") },
      terminalSessions: [child("kid", "topic:orch", "/home/me")],
      openPanels: [], // no open tab, no unread — only the sub-agent keeps it alive
      projectOpenPanes: {},
    });
    const chatRow = items.find((i) => i.id === "orch");
    expect(chatRow).toBeTruthy();
    expect((chatRow!.subAgents ?? []).map((s) => s.id)).toEqual(["terminal:kid"]);
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

  test("a `standalone` topic keeps its projectPath but renders ungrouped (no phantom project node)", () => {
    const items = buildSidebarItems({
      ...base,
      workspaceProjects: [],
      topics: {
        // Catch-all agent session: has a projectPath (its cwd) but standalone.
        s1: topic("s1", "Agent session", { projectPath: PP, standalone: true }),
        // A normal project chat at the SAME path, to prove grouping still works
        // for non-standalone topics and the project row exists because of it.
        n1: topic("n1", "Project chat", { projectPath: PP }),
      },
      terminalSessions: [],
      openPanels: ["s1", "n1"],
      projectOpenPanes: {},
      pinnedIds: new Set<string>(),
    });
    const project = items.find((i) => i.id === `project:${PP}`);
    // The project row exists (n1 seeds it) but must NOT contain the standalone.
    expect(project).toBeTruthy();
    expect((project!.children ?? []).map((c) => c.id)).not.toContain("s1");
    // The standalone session renders as a TOP-LEVEL row, not under the project.
    expect(items.some((i) => i.id === "s1")).toBe(true);
  });

  test("a standalone topic ALONE seeds no project node at all", () => {
    const items = buildSidebarItems({
      ...base,
      workspaceProjects: [],
      topics: { s1: topic("s1", "Agent session", { projectPath: PP, standalone: true }) },
      terminalSessions: [],
      openPanels: ["s1"],
      projectOpenPanes: {},
      pinnedIds: new Set<string>(),
    });
    expect(items.find((i) => i.id === `project:${PP}`)).toBeUndefined();
    expect(items.some((i) => i.id === "s1")).toBe(true);
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

});

/**
 * `pinOnly` — «se sfilo il pin, questa riga sparisce».
 *
 * Il caso vero: un progetto le cui chat sono tutte archiviate stava in sidebar
 * SOLO perché fissato. Trascinare la tessera sulla lista mostrava la riga
 * posarsi al suo posto e poi non lasciava niente. Il cancello lo conosce solo
 * questo modulo, quindi è qui che la risposta va detta.
 */
describe("buildSidebarItems — pinOnly (il pin è l'unica ancora)", () => {
  const soloArchiviate = {
    ...base,
    workspaceProjects: [],
    topics: {
      t1: topic("t1", "vecchia", { projectPath: PP, archived: true }),
      t2: topic("t2", "vecchissima", { projectPath: PP, archived: true }),
    },
    terminalSessions: [],
    projectOpenPanes: {},
  };

  test("progetto con sole chat archiviate, nessuna tab: fissato ⇒ pinOnly", () => {
    const items = buildSidebarItems({
      ...soloArchiviate,
      openPanels: [],
      pinnedIds: new Set([`project:${PP}`]),
    });
    const project = items.find((i) => i.id === `project:${PP}`);
    expect(project).toBeTruthy();
    expect(project!.children).toHaveLength(0);
    expect(project!.pinOnly).toBe(true);
    // …e senza il pin la riga non c'è affatto: è la prova che `pinOnly` non è
    // un'etichetta decorativa ma la descrizione esatta di cosa succede dopo.
    const senzaPin = buildSidebarItems({ ...soloArchiviate, openPanels: [], pinnedIds: new Set() });
    expect(senzaPin.find((i) => i.id === `project:${PP}`)).toBeUndefined();
  });

  test("lo stesso progetto con la sua tab aperta: fissato ma NON pinOnly", () => {
    const items = buildSidebarItems({
      ...soloArchiviate,
      openPanels: [projectPaneId],
      pinnedIds: new Set([`project:${PP}`]),
    });
    const project = items.find((i) => i.id === `project:${PP}`);
    expect(project!.pinned).toBe(true);
    expect(project!.pinOnly).toBeUndefined();
  });

  test("un figlio visibile regge il progetto: niente pinOnly", () => {
    const items = buildSidebarItems({
      ...soloArchiviate,
      topics: {
        ...soloArchiviate.topics,
        t3: topic("t3", "viva", { projectPath: PP }),
      },
      openPanels: ["t3"],
      pinnedIds: new Set([`project:${PP}`]),
    });
    const project = items.find((i) => i.id === `project:${PP}`);
    expect(project!.children!.length).toBeGreaterThan(0);
    expect(project!.pinOnly).toBeUndefined();
  });

  test("chat standalone fissata a tab chiusa ⇒ pinOnly; con la tab aperta no", () => {
    const chiusa = buildSidebarItems({
      ...base,
      workspaceProjects: [],
      topics: { a1: topic("a1", "Alpha") },
      terminalSessions: [],
      openPanels: [],
      projectOpenPanes: {},
      pinnedIds: new Set(["a1"]),
    });
    expect(chiusa.find((i) => i.id === "a1")!.pinOnly).toBe(true);

    const aperta = buildSidebarItems({
      ...base,
      workspaceProjects: [],
      topics: { a1: topic("a1", "Alpha") },
      terminalSessions: [],
      openPanels: ["a1"],
      projectOpenPanes: {},
      pinnedIds: new Set(["a1"]),
    });
    expect(aperta.find((i) => i.id === "a1")!.pinOnly).toBeUndefined();
  });

  test("una chat ARCHIVIATA fissata è pinOnly anche con la tab aperta (la taglia il filtro archiviate)", () => {
    const items = buildSidebarItems({
      ...base,
      workspaceProjects: [],
      topics: { a1: topic("a1", "Alpha", { archived: true }) },
      terminalSessions: [],
      openPanels: ["a1"],
      projectOpenPanes: {},
      pinnedIds: new Set(["a1"]),
    });
    expect(items.find((i) => i.id === "a1")!.pinOnly).toBe(true);
    // Con «mostra archiviate» acceso la riga vive di suo: il pin non è più
    // l'unica ancora.
    const conArchiviate = buildSidebarItems({
      ...base,
      showArchived: true,
      workspaceProjects: [],
      topics: { a1: topic("a1", "Alpha", { archived: true }) },
      terminalSessions: [],
      openPanels: [],
      projectOpenPanes: {},
      pinnedIds: new Set(["a1"]),
    });
    expect(conArchiviate.find((i) => i.id === "a1")!.pinOnly).toBeUndefined();
  });

  test("terminale standalone fissato: pinOnly a tab chiusa, non con la tab aperta", () => {
    const chiuso = buildSidebarItems({
      ...base,
      workspaceProjects: [],
      topics: {},
      terminalSessions: [term("s1", "/elsewhere")],
      openPanels: [],
      projectOpenPanes: {},
      pinnedIds: new Set(["terminal:s1"]),
    });
    expect(chiuso.find((i) => i.id === "terminal:s1")!.pinOnly).toBe(true);

    const aperto = buildSidebarItems({
      ...base,
      workspaceProjects: [],
      topics: {},
      terminalSessions: [term("s1", "/elsewhere")],
      openPanels: ["terminal:s1"],
      projectOpenPanes: {},
      pinnedIds: new Set(["terminal:s1"]),
    });
    expect(aperto.find((i) => i.id === "terminal:s1")!.pinOnly).toBeUndefined();
  });

  test("browser fissato a tab chiusa ⇒ pinOnly (per lui il pin è quasi sempre l'unica ancora)", () => {
    const chiuso = buildSidebarItems({
      ...base,
      workspaceProjects: [],
      topics: {},
      terminalSessions: [],
      openPanels: [],
      projectOpenPanes: {},
      pinnedIds: new Set(["browser:ctx9"]),
    });
    expect(chiuso.find((i) => i.id === "browser:ctx9")!.pinOnly).toBe(true);

    const aperto = buildSidebarItems({
      ...base,
      workspaceProjects: [],
      topics: {},
      terminalSessions: [],
      openPanels: ["browser:ctx9"],
      projectOpenPanes: {},
      pinnedIds: new Set(["browser:ctx9"]),
    });
    expect(aperto.find((i) => i.id === "browser:ctx9")!.pinOnly).toBeUndefined();
  });

  test("niente pinOnly su ciò che non è fissato", () => {
    const items = buildSidebarItems({
      ...base,
      workspaceProjects: [],
      topics: { a1: topic("a1", "Alpha") },
      terminalSessions: [],
      openPanels: ["a1"],
      projectOpenPanes: {},
    });
    expect(items.every((i) => i.pinOnly === undefined)).toBe(true);
  });
});

describe("buildSidebarItems — browser row title (tab/sidebar parity)", () => {
  const browserBase = { ...base, workspaceProjects: [], topics: {}, terminalSessions: [] };
  const CTX = "ctx1";
  const paneId = `browser:${CTX}`;

  test("paneTitleById (global pane store) drives the row name — matches the tab", () => {
    const items = buildSidebarItems({
      ...browserBase,
      openPanels: [paneId],
      paneTitleById: new Map([[paneId, "Example Domain"]]),
    });
    const row = items.find((i) => i.id === paneId);
    expect(row?.name).toBe("Example Domain");
  });

  test("falls back to the server context title when the store has none", () => {
    const items = buildSidebarItems({
      ...browserBase,
      openPanels: [paneId],
      browserContexts: [{ id: CTX, url: "https://news.example.com/x", title: "Server Title", lastActivity: 0 }],
    });
    expect(items.find((i) => i.id === paneId)?.name).toBe("Server Title");
  });

  test("falls back to hostname, then 'Browser', when no title is known", () => {
    const withHost = buildSidebarItems({
      ...browserBase,
      openPanels: [paneId],
      browserContexts: [{ id: CTX, url: "https://www.github.com/foo", title: "", lastActivity: 0 }],
    });
    expect(withHost.find((i) => i.id === paneId)?.name).toBe("github.com");

    const bare = buildSidebarItems({ ...browserBase, openPanels: [paneId] });
    expect(bare.find((i) => i.id === paneId)?.name).toBe("Browser");
  });

  test("the store title wins over a stale server context title", () => {
    const items = buildSidebarItems({
      ...browserBase,
      openPanels: [paneId],
      paneTitleById: new Map([[paneId, "Live Page Title"]]),
      browserContexts: [{ id: CTX, url: "https://example.com", title: "Old Server Title", lastActivity: 0 }],
    });
    expect(items.find((i) => i.id === paneId)?.name).toBe("Live Page Title");
  });
});

// ── Pinned CLOSED project browser — nests under its project with its title ────
//
// A browser pinned INSIDE a project, once its tab is closed, is stripped from
// the project snapshot: without the durable origin the row (1) leaks to the
// top-level Fissati block (no projectPath) and (2) loses its title. The caller
// resolves {projectPath,url,title} from browserOriginStore ∪ closedStack and
// passes it as `browserOriginById`; the builder nests the row back and titles it.
describe("buildSidebarItems — pinned closed project browser (origin nesting)", () => {
  const CTX = "bctx";
  const paneId = `browser:${CTX}`;
  const origin = { projectPath: PP, url: "https://docs.example.com/x", title: "The Docs", ts: 1 };

  test("nests under its origin project as a pinned child (not a top-level row)", () => {
    const items = buildSidebarItems({
      ...base,
      workspaceProjects: [],
      topics: {},
      terminalSessions: [],
      openPanels: [], // tab closed
      projectOpenPanes: {},
      pinnedIds: new Set([paneId]),
      browserOriginById: new Map([[paneId, origin]]),
    });
    // The project row exists (seeded from the origin) …
    const project = items.find((i) => i.id === `project:${PP}`);
    expect(project).toBeTruthy();
    // … the browser is a nested child, pinned, with its durable title …
    const child = project!.children!.find((c) => c.id === paneId);
    expect(child).toBeTruthy();
    expect(child!.type).toBe("browser");
    expect(child!.pinned).toBe(true);
    expect(child!.projectPath).toBe(PP);
    expect(child!.name).toBe("The Docs");
    // … and it does NOT also appear as a top-level Fissati row.
    expect(items.some((i) => i.id === paneId)).toBe(false);
  });

  test("falls back to the origin hostname when no title is known", () => {
    const items = buildSidebarItems({
      ...base,
      workspaceProjects: [],
      topics: {},
      terminalSessions: [],
      openPanels: [],
      projectOpenPanes: {},
      pinnedIds: new Set([paneId]),
      browserOriginById: new Map([[paneId, { projectPath: PP, url: "https://www.github.com/foo", ts: 1 }]]),
    });
    const project = items.find((i) => i.id === `project:${PP}`);
    const child = project!.children!.find((c) => c.id === paneId);
    expect(child?.name).toBe("github.com");
  });

  test("without an origin, a pinned closed browser stays a top-level row (unchanged)", () => {
    const items = buildSidebarItems({
      ...base,
      workspaceProjects: [],
      topics: {},
      terminalSessions: [],
      openPanels: [],
      projectOpenPanes: {},
      pinnedIds: new Set([paneId]),
      // no browserOriginById entry → genuinely unrecoverable
    });
    const row = items.find((i) => i.id === paneId);
    expect(row).toBeTruthy();
    expect(row!.type).toBe("browser");
    expect(row!.pinned).toBe(true);
    expect(row!.projectPath).toBeUndefined();
  });

  test("an OPEN pinned browser is untouched by origin nesting (stays top-level live)", () => {
    const items = buildSidebarItems({
      ...base,
      workspaceProjects: [],
      topics: {},
      terminalSessions: [],
      openPanels: [paneId], // still open at top level
      projectOpenPanes: {},
      pinnedIds: new Set([paneId]),
      browserOriginById: new Map([[paneId, origin]]),
    });
    // Open top-level tab → §5 emits it at the top level, not nested.
    const row = items.find((i) => i.id === paneId);
    expect(row).toBeTruthy();
    expect(row!.projectPath).toBeUndefined();
  });
});

describe("buildSidebarItems — utility tabs (tab-driven, same rule as everything)", () => {
  test("an open utility tab gets a first-class sidebar row (label+icon from PANE_CONFIG)", () => {
    const items = buildSidebarItems({
      ...base,
      workspaceProjects: [],
      terminalSessions: [],
      openPanels: ["__dashboard__"],
      projectOpenPanes: {},
    });
    const dash = items.find((i) => i.id === "__dashboard__");
    expect(dash).toBeTruthy();
    expect(dash!.type).toBe("utility");
    expect(dash!.name).toBe("Dashboard");
    expect(dash!.icon).toBeTruthy();
  });

  // The board is the ONE utility with a dedicated sidebar row of its own (the
  // "Board generale" shortcut at the top of the tree, which also carries the
  // open-task count). Emitting a generic row here as well gave it TWO identical
  // "Board generale" entries as soon as you opened it — one pinned at the top,
  // one appended at the bottom / in Strumenti.
  test("the BOARD is excluded — it has its own dedicated row, a generic one would duplicate it", () => {
    const items = buildSidebarItems({
      ...base,
      workspaceProjects: [],
      terminalSessions: [],
      openPanels: ["__board__", "__dashboard__"],
      projectOpenPanes: {},
    });
    expect(items.find((i) => i.id === "__board__")).toBeUndefined();
    // …while the other utilities still get theirs.
    expect(items.find((i) => i.id === "__dashboard__")).toBeTruthy();
  });

  test("a closed utility tab has no row (the sidebar mirrors open tabs)", () => {
    const items = buildSidebarItems({
      ...base,
      workspaceProjects: [],
      terminalSessions: [],
      openPanels: [],
      projectOpenPanes: {},
    });
    expect(items.find((i) => i.type === "utility")).toBeUndefined();
  });

  // Il modo "per tipo" e' stato rimosso (06/08) e con lui `groupSidebarItems`:
  // qui si verificava che una riga utility finisse nella sua sezione. Quello che
  // resta da difendere e' che la riga utility ESISTA con il suo tipo — il resto
  // era una proprieta' di una vista che non c'e' piu'.
  test("una tab utility aperta produce la sua riga, di tipo utility", () => {
    const items = buildSidebarItems({
      ...base,
      workspaceProjects: [],
      terminalSessions: [],
      openPanels: ["__dashboard__"],
      projectOpenPanes: {},
    });
    const utility = items.filter((i) => i.type === "utility");
    expect(utility.map((i) => i.id)).toEqual(["__dashboard__"]);
  });

  /**
   * Parity with the tab bar. `extraCounts` is the badge source `getBadgeCount`
   * falls back to for every pane that is neither a chat nor a terminal — agents
   * panes on agent:nudge / agent:escalation / a session finishing, and
   * `extraCounts`. Il conto della riga è lo STESSO della sua tab: la riga
   * tornava 0 fisso, quindi la stessa pane poteva mostrare un badge su una
   * superficie e niente sull'altra.
   */
  test("a utility row carries the SAME count its tab does (extraCounts)", () => {
    const items = buildSidebarItems({
      ...base,
      workspaceProjects: [],
      terminalSessions: [],
      openPanels: ["__dashboard__", "__cron__"],
      projectOpenPanes: {},
      extraCounts: new Map([["__dashboard__", 3]]),
    });
    expect(items.find((i) => i.id === "__dashboard__")!.notificationCount).toBe(3);
    // …and a pane nobody badged stays at zero rather than inheriting a count.
    expect(items.find((i) => i.id === "__cron__")!.notificationCount).toBe(0);
  });

  test("no extraCounts at all leaves every utility row at zero", () => {
    const items = buildSidebarItems({
      ...base,
      workspaceProjects: [],
      terminalSessions: [],
      openPanels: ["__dashboard__"],
      projectOpenPanes: {},
    });
    expect(items.find((i) => i.id === "__dashboard__")!.notificationCount).toBe(0);
  });

  test("a browser row reads extraCounts too, instead of a hard-coded zero", () => {
    const paneId = "browser:ctx-1";
    const items = buildSidebarItems({
      ...base,
      workspaceProjects: [],
      terminalSessions: [],
      openPanels: [paneId],
      projectOpenPanes: {},
      extraCounts: new Map([[paneId, 2]]),
    });
    expect(items.find((i) => i.id === paneId)!.notificationCount).toBe(2);
  });
});

describe("buildSidebarItems — terminal lastActivity reflects real Claude activity", () => {
  // term()'s createdAt is fixed at new Date(0) — every case below overrides
  // sessionLastActivityById (keyed by terminal id, from signals.ts's
  // deriveSessionLastActivity) to isolate the fold from createdAt.
  test("uses the session's last-touched timestamp when newer than createdAt", () => {
    const items = buildSidebarItems({
      ...base,
      terminalSessions: [term("s1", "/home/me")],
      openPanels: ["terminal:s1"],
      sessionLastActivityById: new Map([["s1", 5000]]),
    });
    const row = items.find((i) => i.id === "terminal:s1");
    expect(row?.lastActivity).toBe(5000);
  });

  test("falls back to createdAt when no session-activity entry exists (hook-less/untouched session)", () => {
    const items = buildSidebarItems({
      ...base,
      terminalSessions: [term("s1", "/home/me")],
      openPanels: ["terminal:s1"],
    });
    const row = items.find((i) => i.id === "terminal:s1");
    expect(row?.lastActivity).toBe(new Date(0).getTime());
  });

  test("never sorts a session BEFORE its own creation time (stale/race session-activity value)", () => {
    const items = buildSidebarItems({
      ...base,
      terminalSessions: [term("s1", "/home/me")],
      openPanels: ["terminal:s1"],
      sessionLastActivityById: new Map([["s1", -1000]]),
    });
    const row = items.find((i) => i.id === "terminal:s1");
    expect(row?.lastActivity).toBe(new Date(0).getTime());
  });

  test("a finished session (idle phase, no live activity label) still sorts by its real finish time", () => {
    // deriveSessionActivity would drop this session's entry entirely (idle),
    // but deriveSessionLastActivity — the map this option is fed from — keeps
    // it, so a completed run doesn't collapse back to createdAt ordering.
    const items = buildSidebarItems({
      ...base,
      terminalSessions: [term("old", "/home/me"), term("recent", "/home/me")],
      openPanels: ["terminal:old", "terminal:recent"],
      sessionLastActivityById: new Map([
        ["old", 1000],
        ["recent", 9000],
      ]),
    });
    const sorted = items
      .filter((i) => i.type === "terminal")
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .map((i) => i.id);
    expect(sorted).toEqual(["terminal:recent", "terminal:old"]);
  });
});

/**
 * Appartenenza al GRUPPO.
 *
 * Il difetto che questi test inchiodano: la sidebar è guidata dalle tab ma con
 * parecchie vie di fuga (non letti, "attende te", fissati, orchestratori), e
 * quelle vie di fuga producevano righe che NON appartenevano al gruppo aperto.
 * Nel caso reale che l'ha fatto vedere, il progetto `topics-app` viveva in
 * "Gruppo 2" e compariva lo stesso — con dentro la sua sessione — sotto
 * l'intestazione di "Principale".
 */
describe("groupSidebarItemsBySpace", () => {
  const item = (over: Partial<SidebarItem> & Pick<SidebarItem, "id" | "type">): SidebarItem => ({
    name: over.id,
    icon: "",
    lastActivity: 0,
    notificationCount: 0,
    archived: false,
    ...over,
  });

  test("un progetto si riconosce dal path CODIFICATO della sua pane", () => {
    const project = item({ id: `project:${PP}`, type: "project", projectPath: PP });
    expect(sidebarItemPaneId(project)).toBe(projectPaneId);
    const { bySpace, loose } = groupSidebarItemsBySpace(
      [project],
      new Map([[projectPaneId, "space:1"]]),
    );
    expect(bySpace.get("space:1")).toHaveLength(1);
    expect(loose).toEqual([]);
  });

  test("ogni riga finisce nel SUO gruppo, non in quello che stai guardando", () => {
    const a = item({ id: "a", type: "chat" });
    const b = item({ id: "b", type: "chat" });
    const { bySpace } = groupSidebarItemsBySpace(
      [a, b],
      new Map([["a", "space:1"], ["b", "space:2"]]),
    );
    expect(bySpace.get("space:1")?.map((i) => i.id)).toEqual(["a"]);
    expect(bySpace.get("space:2")?.map((i) => i.id)).toEqual(["b"]);
  });

  test("una riga senza pane aperta non sta in nessun gruppo", () => {
    const chat = item({ id: "t1", type: "chat", notificationCount: 3 });
    const { bySpace, loose } = groupSidebarItemsBySpace([chat], new Map());
    expect(bySpace.size).toBe(0);
    expect(loose.map((i) => i.id)).toEqual(["t1"]);
  });

  test("nemmeno un fissato inventa un gruppo", () => {
    const pinned = item({ id: "terminal:x", type: "terminal", pinned: true });
    const { loose } = groupSidebarItemsBySpace([pinned], new Map());
    expect(loose.map((i) => i.id)).toEqual(["terminal:x"]);
  });

  test("l'ordine dentro ciascun gruppo è quello che aveva il builder", () => {
    const items = ["a", "b", "c", "d"].map((id) => item({ id, type: "chat" }));
    const { bySpace, loose } = groupSidebarItemsBySpace(
      items,
      new Map([["a", "space:1"], ["b", "space:2"], ["c", "space:1"]]),
    );
    expect(bySpace.get("space:1")?.map((i) => i.id)).toEqual(["a", "c"]);
    expect(bySpace.get("space:2")?.map((i) => i.id)).toEqual(["b"]);
    expect(loose.map((i) => i.id)).toEqual(["d"]);
  });
});
