/* acme: the landing page's demo, a generic software team (no real project or
 * user data). Its result must stay what the landing has always shown.
 *
 * THREE GROUPS, which is the model this demo exists to show: a group is a set
 * of tabs you live in, and a window is just a group that has been detached.
 *   Principale (implicit) -> acme-web ALONE, one window filling the frame: allow-italian: group name
 *                            terminals | the stage tabs.
 *   Progetti              -> acme-api + acme-mobile + acme-docs, three windows in one grid. allow-italian: group name
 *   Numeri                -> the standalone Board generale + Dashboard panes. allow-italian: group name
 * A landing chapter navigates by SWITCHING GROUP, not by dragging dividers: the
 * pane it is about lands full-frame. landing-cursor.js looks tabs up by pane id. */
import type { LandingScenario } from "../scenario";
import type { BoardTask } from "../../lib/board";
import type { Pane, TerminalSessionInfo } from "../../types";
import { projectIdForPath } from "../../../../shared/board";
import { ACME_FALLBACK_TRANSCRIPT, ACME_PROC_OUT, ACME_TRANSCRIPTS } from "./acme-terminals";
import { appSettings, boardSettings, boardTask, emptyUsage, idleDispatchCapacity, paneStore, projectPaneId, systemStatus, topic } from "./common";

const PROJECT = "/demo/acme-web"; // the working project (its own group)
const P2 = "/demo/acme-api";      // siblings: they share the "Progetti" group, allow-italian: group name
const P3 = "/demo/acme-mobile";   // three windows in one grid
const P4 = "/demo/acme-docs";
const SPACE_PROJECTS = "space:projects", SPACE_NUMBERS = "space:numbers";
/* The board id the server derives from the path (`<basename>-<hash>`): the
 * Board generale prints its chip from it. The path itself read "/demo/acme". */
const BOARD_ID = projectIdForPath(PROJECT);
const WEB_PANE = projectPaneId(PROJECT), API_PANE = projectPaneId(P2), MOBILE_PANE = projectPaneId(P3), DOCS_PANE = projectPaneId(P4);
// Inner project panes (ids unique across the app). Each project's star is a
// Claude Code agent session; there is no standalone git pane.
const CC1 = "terminal:cc1", CC2 = "terminal:cc2", CC3 = "terminal:cc3", CC4 = "terminal:cc4", CC6 = "terminal:cc6", BROW = "browser:c1";
/* App-level utility panes: these two render STANDALONE (StandaloneChatGroup has
 * a branch for them), so they can be a group of their own. git, files and the
 * per-project board only exist inside a ProjectWindow. */
const BOARD_APP = "__board__", DASH_APP = "__dashboard__";
/* The chapter stage: the right-hand column of acme-web. Each landing chapter
 * switches this group to one of these tabs, a REAL pane reached by a real tab
 * click. Adding a chapter here is the only change needed on the app side. */
const BOARD_TAB = "kanban:c1", GIT_TAB = "git:c1", FILES_TAB = "files:c1";

function sessionPane(id: string, sid: string, path: string): Pane {
  return { id, type: "terminal", title: "Claude Code", projectPath: path, terminalSessionId: sid, terminalType: "claude-code" };
}
/** A project window holding one working Claude Code session, sidebar collapsed. */
function soloSessionProject(path: string, pane: Pane, group: string) {
  return {
    path,
    panes: { nonChatPanes: [pane], openChatTopicIds: [] },
    layout: { groups: [{ id: group, paneIds: [pane.id], activePaneId: pane.id, type: "utility" as const }], rows: [{ groupIds: [group], widths: [1] }], rowHeights: [1], sidebarCollapsed: true, focusedGroupId: group },
  };
}

export function createAcmeScenario(): LandingScenario {
  /* The demo's "now" is the visitor's: a frozen literal aged with the build
   * (a live session rendered as `1515.6h`). Anchored a few minutes back so the
   * sessions read as freshly active. The charts are sine-shaped, not random,
   * so only the date LABELS move. */
  const ISO = new Date(Date.now() - 4 * 60000).toISOString();
  /* Board cards are a day old on purpose: `fmtUpdatedAt` prints a numeric
   * dd/MM HH:MM past twelve hours, which reads the same in both languages
   * while the board still has a few hardcoded Italian strings. */
  const BOARD_ISO = new Date(Date.now() - 26 * 3600 * 1000).toISOString();

  const gitStatus = {
    branch: "main", ahead: 2, behind: 0,
    lastCommit: { hash: "a1b2c3d", message: "feat(ui): aurora pass", author: "you", ago: "3 min ago" },
    // Short on purpose: inside a stacked project sidebar a long list overflows.
    files: [
      { path: "src/components/Hero.tsx", status: "M" },
      { path: "src/lib/analytics.ts", status: "M" },
    ],
  };
  const task = (id: string, text: string, status: BoardTask["status"], kanbanOrder: number, priority: number, assignedTo?: string, description?: string) =>
    boardTask({ id, projectId: BOARD_ID, text, status, kanbanOrder, at: BOARD_ISO, priority, assignedTo, description });
  /* The board tells the WHOLE loop in one screen: queued, an agent picked it up
   * in its own worktree, delivered and waiting for a human, landed. */
  const tasks = [
    task("k1", "Wire telemetry opt-in", "backlog", 0, 1),
    task("k2", "Localize onboarding", "backlog", 1, 1),
    task("k3", "Sign release builds", "todo", 0, 3),
    task("k4", "Empty-state polish", "todo", 1, 2),
    /* Priority 2 on purpose: the card shows a priority pill only for a hand-set
     * non-default value, and its label is still hardcoded Italian. This is the
     * card the site crops for its "Ship" image. */
    task("k5", "Ship v2.2 release notes", "in_progress", 0, 2, "claude", "Agent working in an isolated worktree."),
    task("k6", "Landing site rebuild", "in_progress", 1, 3, "claude"),
    task("k7", "Token hashing", "review", 0, 3, "claude", "Delivered — waiting for your approval."), // allow-emdash: shipped landing copy, kept identical
    task("k11", "Reload-safe dispatch", "review", 1, 2, "claude"),
    task("k8", "Split panes", "done", 0, 2),
    task("k9", "Auto-update", "done", 1, 2),
    task("k10", "Grain + aurora", "done", 2, 1),
  ];
  // Topics are secondary in this story: the Claude Code sessions are the value.
  const topics = [
    topic({ id: "t-ship", name: "ship v1.1", icon: "🚀", color: "#5b8cff", at: ISO }),
    topic({ id: "t-landing", name: "landing site", icon: "🎨", color: "#7c6cff", at: ISO }),
    topic({ id: "t-auth", name: "auth flow", icon: "🔒", color: "#22d3ee", at: ISO }),
    topic({ id: "t-bugs", name: "bug triage", icon: "🐞", color: "#f5a524", at: ISO }),
  ];
  /* Running terminal sessions: the Claude Code agents ("claude-code" -> Claude
   * icon in the sidebar, grouped under their project by cwd). */
  const ccSession = (id: string, cwd: string, busy: boolean): TerminalSessionInfo =>
    ({ id, name: "Claude Code", cwd, command: "claude", createdAt: ISO, clients: 1, busy, type: "claude-code" });
  const sessions: TerminalSessionInfo[] = [
    ccSession("cc1", PROJECT, true),
    ccSession("cc2", PROJECT, true),
    { id: "sh1", name: "zsh", cwd: PROJECT, command: "/bin/zsh", createdAt: ISO, clients: 1, busy: false, type: "shell" },
    ccSession("cc3", P2, true),
    ccSession("cc4", P3, false),
    ccSession("cc5", P3, true),
    ccSession("cc6", P4, true),
  ];
  /* Dashboard series: 14 days, deterministic (no Math.random) so every visitor
   * sees the same chart and screenshots are reproducible. */
  const series = (base: number, spread: number, scale: number) => {
    const day0 = Date.parse(ISO) - 13 * 86400000;
    return Array.from({ length: 14 }, (_, i) => {
      const w = Math.sin(i * 1.1) * 0.6 + Math.sin(i * 0.37) * 0.4; // two out-of-phase sines, no RNG
      return { date: new Date(day0 + i * 86400000).toISOString().slice(0, 10), value: Math.round(Math.max(0, base + w * spread) * scale) / scale };
    });
  };
  const SERIES = { throughput: series(9, 4, 1), spend: series(2.6, 1.2, 100), cycle: series(3.1, 1.1, 10) };
  const gitDiff =
    "diff --git a/src/components/Hero.tsx b/src/components/Hero.tsx\n" +
    "index 1a2b3c4..5d6e7f8 100644\n--- a/src/components/Hero.tsx\n+++ b/src/components/Hero.tsx\n" +
    "@@ -12,7 +12,9 @@ export function Hero() {\n   return (\n" +
    "-    <section className=\"hero\">\n+    <section className=\"hero hero--aurora\">\n+      <Grain />\n" +
    "       <h1>{title}</h1>\n       <p>{subtitle}</p>\n     </section>\n   );\n";

  return {
    name: "acme",
    seed: {
      /* acme-web + acme-api + acme-mobile + acme-docs are ALL OPEN: you keep
       * several projects live at once. `spaceId` absent = the default group. */
      paneStore: paneStore([
        { id: WEB_PANE, type: "project", projectPath: PROJECT, title: "acme-web", stableKey: WEB_PANE },
        { id: API_PANE, type: "project", projectPath: P2, title: "acme-api", stableKey: API_PANE, spaceId: SPACE_PROJECTS },
        { id: MOBILE_PANE, type: "project", projectPath: P3, title: "acme-mobile", stableKey: MOBILE_PANE, spaceId: SPACE_PROJECTS },
        { id: DOCS_PANE, type: "project", projectPath: P4, title: "acme-docs", stableKey: DOCS_PANE, spaceId: SPACE_PROJECTS },
        { id: BOARD_APP, type: "board", title: "Board generale", stableKey: BOARD_APP, spaceId: SPACE_NUMBERS },
        { id: DASH_APP, type: "dashboard", title: "Dashboard", stableKey: DASH_APP, spaceId: SPACE_NUMBERS },
      ], {
        // One record per NON-default group, id === its key.
        [SPACE_PROJECTS]: { id: SPACE_PROJECTS, name: "Progetti", order: 0, updatedAt: 1748856600000 }, // allow-italian: the group names the landing has always shown
        [SPACE_NUMBERS]: { id: SPACE_NUMBERS, name: "Numeri", order: 1, updatedAt: 1748856600000 }, // allow-italian: the group names the landing has always shown
      }),
      focusedPaneId: WEB_PANE,
      /* Only "Progetti" needs a grid overlay: three windows. The solo-cell item allow-italian: group name
       * key is `solo:<paneId>` (soloCells.ts), or PanelGrid re-merges all into row 0. */
      gridLayouts: {
        [SPACE_PROJECTS]: {
          gridRows: [
            { itemKeys: ["solo:" + API_PANE], widths: [1] },
            { itemKeys: ["solo:" + MOBILE_PANE, "solo:" + DOCS_PANE], widths: [0.5, 0.5] },
          ],
          gridRowHeights: [0.56, 0.44],
          soloCells: [[API_PANE], [MOBILE_PANE], [DOCS_PANE]],
          soloTopicIds: [API_PANE, MOBILE_PANE, DOCS_PANE],
        },
      },
      projects: [
        {
          path: PROJECT,
          panes: {
            nonChatPanes: [
              sessionPane(CC1, "cc1", PROJECT),
              sessionPane(CC2, "cc2", PROJECT),
              { id: BROW, type: "browser", title: "Preview", projectPath: PROJECT },
              { id: BOARD_TAB, type: "kanban", title: "Board", projectPath: PROJECT },
              { id: GIT_TAB, type: "git", title: "Git", projectPath: PROJECT },
              { id: FILES_TAB, type: "files", title: "Files", projectPath: PROJECT },
            ],
            openChatTopicIds: [],
          },
          layout: {
            groups: [
              { id: "pgA-l", paneIds: [CC1, CC2], activePaneId: CC1, type: "utility" },
              { id: "pgA-r", paneIds: [BROW, BOARD_TAB, GIT_TAB, FILES_TAB], activePaneId: BROW, type: "utility" },
            ],
            // 42/58 in favour of the stage; the terminals keep enough width for
            // Claude Code's own wrapping.
            rows: [{ groupIds: ["pgA-l", "pgA-r"], widths: [0.42, 0.58] }],
            rowHeights: [1], sidebarCollapsed: false, focusedGroupId: "pgA-l",
          },
        },
        soloSessionProject(P2, sessionPane(CC3, "cc3", P2), "pgB"),
        soloSessionProject(P3, sessionPane(CC4, "cc4", P3), "pgC"),
        soloSessionProject(P4, sessionPane(CC6, "cc6", P4), "pgD"),
      ],
      theme: "dark",
      /* English, explicitly, not "auto": resolveLocale falls back to ITALIAN for
       * any browser that does not announce English, and this demo sits in an
       * English landing page. */
      settings: { sidebarCollapsed: false, language: "en" },
      // Expand the projects so their sessions show (sidebar item id = "project:<path>", unencoded).
      sidebar: {
        expandedNodes: ["project:" + PROJECT, "project:" + P2, "project:" + P3, "project:" + P4],
        viewMode: "timeline", showArchived: false,
        showProjects: true, showChats: true, showTerminals: true,
        showProjectsArchived: false, showChatsArchived: false, browserExpanded: false,
      },
      gitStatusCache: Object.fromEntries([PROJECT, P2, P3].map((p) => [p, { status: gitStatus, remotes: [] }])),
      // Processes open (the running dev server is the context worth showing), Files and Git closed.
      sidebarSections: { files: false, git: false, processes: true },
    },
    api: {
      // Loopback + owner is what the real app reports on the machine it runs on.
      session: { paired: true, as: "loopback", name: "This Mac", deviceId: "demo-loopback", role: "owner", personId: null },
      appSettings: appSettings(),
      people: { people: [] },
      friendships: { friends: [], incoming: [], outgoing: [] },
      devices: { devices: [] },
      gitDiff,
      fileContent: "// generic preview\nexport const hello = 'world';\n",
      systemStatus: systemStatus(ISO, 5, 4),
      topics: { topics: Object.fromEntries(topics.map((t) => [t.id, t])), workspaceProjects: [PROJECT, P2, P3] },
      gitStatus,
      gitBranches: [{ name: "main", current: true, isRemote: false }, { name: "feat/aurora", current: false, isRemote: false }],
      gitRemotes: [{ name: "origin", fetchUrl: "git@github.com:acme/acme-web.git", pushUrl: "git@github.com:acme/acme-web.git" }],
      gitLog: [],
      allBoardTasks: tasks,
      // Every project board shows the same cards: the stage's Board tab is acme-web's.
      projectBoardTasks: () => tasks,
      boardSettings: () => boardSettings(BOARD_ID),
      dispatchCapacity: idleDispatchCapacity(),
      scriptOutput: { output: ACME_PROC_OUT, offset: ACME_PROC_OUT.length, done: true, status: "running" },
      scripts: [
        { processId: "p1", scriptName: "dev", command: "vite dev", projectPath: PROJECT, status: "running", pid: 4821, startedAt: ISO, ports: [5173], source: "script" },
        { processId: "p2", scriptName: "server", command: "bun server.ts", projectPath: PROJECT, status: "running", pid: 4830, startedAt: ISO, ports: [3333], source: "script" },
        { processId: "p3", scriptName: "test", command: "bun test", projectPath: PROJECT, status: "done", pid: null, startedAt: ISO, completedAt: ISO, exitCode: 0, ports: [] },
      ],
      terminalSessions: sessions,
      history: () => ({ messages: [] }),
      providersSnapshot: { providers: [], defaultProvider: null, generatedAt: ISO },
      providers: { providers: [], default: null },
      projects: [
        { id: "p-acme", name: "acme-web", path: PROJECT, slug: "acme-web", color: "#5b8cff", icon: null, archived: false, createdAt: ISO, updatedAt: ISO },
        { id: "p-acme-api", name: "acme-api", path: P2, slug: "acme-api", color: "#22d3ee", icon: null, archived: false, createdAt: ISO, updatedAt: ISO },
        { id: "p-acme-mob", name: "acme-mobile", path: P3, slug: "acme-mobile", color: "#7c6cff", icon: null, archived: false, createdAt: ISO, updatedAt: ISO },
        { id: "p-acme-doc", name: "acme-docs", path: P4, slug: "acme-docs", color: "#22c55e", icon: null, archived: false, createdAt: ISO, updatedAt: ISO },
      ],
      machines: [],
      worktrees: [],
      kpis: { throughputDay: 12, throughputWeek: 64, avgCycleTimeHours: 3.2, wipCount: 4, errorRate: 0.02, tokenSpendDay: 1.4, tokenSpendWeek: 9.1, approvalTurnaroundHours: 1.1, pendingApprovals: 0 },
      timeseries: (metric) => /spend|token|cost/i.test(metric) ? SERIES.spend : /cycle|time|duration/i.test(metric) ? SERIES.cycle : SERIES.throughput,
      packageScripts: {
        scripts: [
          { id: "package.json#dev", name: "dev", detail: "vite dev", argv: ["bun", "run", "dev"], from: "package.json" },
          { id: "package.json#build", name: "build", detail: "vite build", argv: ["bun", "run", "build"], from: "package.json" },
          { id: "package.json#server", name: "server", detail: "bun server.ts", argv: ["bun", "run", "server"], from: "package.json" },
          { id: "package.json#test", name: "test", detail: "bun test", argv: ["bun", "run", "test"], from: "package.json" },
          { id: "package.json#lint", name: "lint", detail: "eslint .", argv: ["bun", "run", "lint"], from: "package.json" },
        ],
        found: ["package.json"],
        looked: ["package.json", "Makefile", "Cargo.toml"],
      },
      files: [
        { name: "src", type: "dir", path: PROJECT + "/src", children: [] },
        { name: "public", type: "dir", path: PROJECT + "/public", children: [] },
        { name: "package.json", type: "file", path: PROJECT + "/package.json", size: 1820 },
        { name: "README.md", type: "file", path: PROJECT + "/README.md", size: 3400 },
      ],
      usage: emptyUsage(ISO),
      openclawContext: { soul: null, memory: null, agents: null, tools: null, identity: null, user: null, memoryIndex: [], memoryTokens: 0, totalTokens: 0, workspacePath: PROJECT },
    },
    sockets: {
      terminals: { transcripts: ACME_TRANSCRIPTS, fallback: ACME_FALLBACK_TRANSCRIPT },
      browser: { url: "https://acme.example.com/dashboard", frameB64: __DEMO_BROWSER_FRAME__, snapshot: __DEMO_DOM_SNAPSHOT__ },
      main: {
        sessions: { type: "terminal:sessions", sessions },
        /* Detached windows: presence is fed only by `presence:windows` on the main
         * socket. presenceWindowsBroadcastSchema (shared/ws-outbound.ts) drops a
         * frame with one wrong field in silence, and the ids must differ from this
         * tab's own `topics-window-id` or the app reads its own reflection. */
        presence: {
          type: "presence:windows",
          windows: [
            /* `tabs` is what the sidebar's "Finestre" groups. The second window allow-italian: the sidebar label
             * announces only `topicIds` (an older client) on purpose: it still
             * renders, through windowTabs()'s fallback. */
            { windowId: "w-demo-detached", clientId: "c-demo-2", windowLabel: "detach-acme-auth", detached: true, topicIds: ["t-auth", "t-bugs"],
              tabs: [
                { id: "t-auth", type: "chat", title: "auth flow" },
                { id: "t-bugs", type: "chat", title: "bug triage" },
                { id: "terminal:cc9", type: "terminal", title: "Claude Code" },
                { id: "browser:c9", type: "browser", title: "localhost:3000" },
              ] },
            { windowId: "w-demo-main", clientId: "c-demo-3", detached: false, topicIds: ["t-ship"] },
          ],
        },
      },
    },
  };
}
