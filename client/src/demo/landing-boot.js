/* ─────────────────────────────────────────────────────────────────────────
 * Topics landing demo — boot shim (classic script, runs BEFORE the app bundle)
 *
 * Makes the REAL Topics client run with NO backend, purely client-side:
 *   1. Seeds localStorage so the app boots straight into a dark-theme view:
 *      a single PROJECT window whose inner layout is a split —
 *      terminal (left) | Browser / Git / Process / Board tabs (right).
 *   2. Monkeypatches window.fetch to answer every /api/* call with generic
 *      mock data (endpoint URLs + shapes mirror client/src/lib/api.ts).
 *   3. Monkeypatches window.WebSocket with a stub that feeds canned frames:
 *        /ws/terminal/<id>  → ANSI shell output + replay-end
 *        /ws/browser/<id>   → nav + one screenshot frame
 *        /ws (main)         → unread:init so topics appear in the sidebar
 *
 * NOTHING here references real user/project data — it's a generic showcase.
 * Maintainability: this IS the real app bundle; only this one file is the
 * demo seam. Rebuild via `npm run build:landing` after any client change.
 * ───────────────────────────────────────────────────────────────────────── */
(function () {
  "use strict";
  var PROJECT = "/demo/acme-web";   // the open project (the rich split below)
  var P2 = "/demo/acme-api";        // sibling projects — shown in the sidebar with
  var P3 = "/demo/acme-mobile";     // their own running Claude Code sessions
  var ISO = "2026-06-02T09:30:00.000Z";

  // The "figata": THREE projects open at once. acme-web full-width on top;
  // acme-api + acme-mobile side-by-side below. Each is its own ProjectWindow —
  // the project sidebar (Tasks/Files/Git/Processes) IS the interesting context,
  // so no redundant Git tab. App-level pane id == createPaneId('project', path).
  function projPaneId(p) { return "project:" + encodeURIComponent(p); }
  var PROJ_A = projPaneId(PROJECT);   // top, full width
  var PROJ_B = projPaneId(P2);        // bottom-left
  var PROJ_C = projPaneId(P3);        // bottom-right
  // Inner project panes (ids unique across the app). Each project's star is a
  // Claude Code agent session (the paid core value); no standalone git pane.
  var CC1 = "terminal:cc1", CC2 = "terminal:cc2", CC3 = "terminal:cc3", CC4 = "terminal:cc4",
      BROW = "browser:c1", BOARD = "board:b1";

  /* djb2-style hash — MUST match projectHash() in
   * state/pane/adapters/projectLayoutSync.ts so the project-layout keys line up. */
  function projectHash(p) {
    var hash = 0;
    for (var i = 0; i < p.length; i++) { hash = p.charCodeAt(i) + ((hash << 5) - hash); hash = hash & hash; }
    return Math.abs(hash).toString(36);
  }

  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  /* ---- 1a. App-level pane store: THREE open project panes --------------- *
   * acme-web + acme-api + acme-mobile are ALL OPEN — that's the headline: you
   * keep several projects live at once. acme-web spans the top (it carries the
   * browser preview); acme-api + acme-mobile share the bottom row side-by-side. */
  var appPanes = {};
  appPanes[PROJ_A] = { id: PROJ_A, type: "project", projectPath: PROJECT, title: "acme-web",    stableKey: PROJ_A };
  appPanes[PROJ_B] = { id: PROJ_B, type: "project", projectPath: P2,      title: "acme-api",    stableKey: PROJ_B };
  appPanes[PROJ_C] = { id: PROJ_C, type: "project", projectPath: P3,      title: "acme-mobile", stableKey: PROJ_C };
  set("pane-store-v2", JSON.stringify({
    panes: appPanes,
    groups: { "group:default": { id: "group:default", paneIds: [PROJ_A, PROJ_B, PROJ_C], splitRatio: 0.5, splitAxis: "vertical" } },
    groupOrder: ["group:default"],
    closedStack: [],
    lastSeq: 1000,
    // The reducer's LWW gate drops a hydrate unless server_seq beats the live
    // lastSeq (which starts at 0). hydrateFromLocalSnapshot derives the applied
    // seq from server_seq — so set it high to guarantee the seed applies.
    server_seq: 1000,
    savedAt: 1748856600000,
    senderId: "landing-demo",
  }));
  set("pane-store-focused-id", PROJ_A);

  // Device-local grid overlay: acme-web spans the FULL-WIDTH top row; acme-api
  // and acme-mobile share the bottom row 50/50. Top row gets the larger share so
  // the project that carries the browser preview stays legible. The grid item key
  // for a solo cell is `solo:<paneId>` (soloCells.ts soloCellKey) — it MUST match
  // or PanelGrid's additive-sync re-merges everything into row 0.
  set("topics-panel-grid-layout", JSON.stringify({
    gridRows: [
      { itemKeys: ["solo:" + PROJ_A], widths: [1] },
      { itemKeys: ["solo:" + PROJ_B, "solo:" + PROJ_C], widths: [0.5, 0.5] },
    ],
    gridRowHeights: [0.56, 0.44],
    // soloCells is a flat list of CELLS (each inner array = one cell's tabs), NOT
    // rows. Three single-pane cells → three separate ProjectWindows; the row/
    // column arrangement comes from gridRows above (B and C share the 2nd row).
    soloCells: [[PROJ_A], [PROJ_B], [PROJ_C]],
    soloTopicIds: [PROJ_A, PROJ_B, PROJ_C],
  }));

  /* ---- 1b. Per-project inner layouts ----------------------------------- *
   * Each open project shows a live Claude Code session; the project sidebar
   * (Tasks/Files/Git/Processes) supplies the rest of the context.
   *   acme-web (top):    two Claude sessions (tabs) | browser/board
   *   acme-api (bottom): a Claude session (working)                            */
  function seedProject(path, panes, layout) {
    set("topics-project-panes-" + projectHash(path), JSON.stringify({ nonChatPanes: panes, openChatTopicIds: [], activeChatTopicId: undefined }));
    set("topics-project-layout-" + projectHash(path), JSON.stringify(layout));
  }
  seedProject(PROJECT, [
    { id: CC1,   type: "terminal", title: "Claude Code", projectPath: PROJECT, terminalSessionId: "cc1", terminalType: "claude-code" },
    { id: CC2,   type: "terminal", title: "Claude Code", projectPath: PROJECT, terminalSessionId: "cc2", terminalType: "claude-code" },
    { id: BROW,  type: "browser",  title: "Preview",     projectPath: PROJECT },
  ], {
    groups: [
      { id: "pgA-l", paneIds: [CC1, CC2],     activePaneId: CC1,  type: "utility" },
      { id: "pgA-r", paneIds: [BROW],         activePaneId: BROW, type: "utility" },
    ],
    rows: [{ groupIds: ["pgA-l", "pgA-r"], widths: [0.54, 0.46] }],
    rowHeights: [1], sidebarCollapsed: false, focusedGroupId: "pgA-l",
  });
  seedProject(P2, [
    { id: CC3, type: "terminal", title: "Claude Code", projectPath: P2, terminalSessionId: "cc3", terminalType: "claude-code" },
  ], {
    groups: [{ id: "pgB", paneIds: [CC3], activePaneId: CC3, type: "utility" }],
    rows: [{ groupIds: ["pgB"], widths: [1] }],
    rowHeights: [1], sidebarCollapsed: true, focusedGroupId: "pgB",
  });
  // acme-mobile (P3): the third open project (bottom-right). A single working
  // Claude Code session; sidebar collapsed so the narrow half-column stays clean.
  seedProject(P3, [
    { id: CC4, type: "terminal", title: "Claude Code", projectPath: P3, terminalSessionId: "cc4", terminalType: "claude-code" },
  ], {
    groups: [{ id: "pgC", paneIds: [CC4], activePaneId: CC4, type: "utility" }],
    rows: [{ groupIds: ["pgC"], widths: [1] }],
    rowHeights: [1], sidebarCollapsed: true, focusedGroupId: "pgC",
  });

  /* ---- 1c. theme + misc ------------------------------------------------- */
  set("theme", JSON.stringify("dark"));
  // Board + Master are opt-out in the latest UI — the demo reflects the cleaner
  // surface (no Board/Master in the sidebar, no Board tab in the project window).
  set("app-settings", JSON.stringify({ sidebarCollapsed: false, showBoard: false, showMaster: false }));
  // Collapse the project sidebar's Tasks board (kanban still 1 click away via the
  // Board tab) so the tall task list stops pushing Files/Git/Processes off-screen
  // → the running Processes become visible, which is the project context Attilio
  // wants to see.
  set("topics-taskboard-collapsed", "true");
  // Expand all three projects so their Claude Code sessions are visible at a
  // glance (sidebar item id == "project:<path>", unencoded — see buildSidebarItems).
  set("topics-sidebar-state", JSON.stringify({
    expandedNodes: ["project:" + PROJECT, "project:" + P2, "project:" + P3],
    viewMode: "timeline", showArchived: false,
    showProjects: true, showChats: true, showTerminals: true,
    showProjectsArchived: false, showChatsArchived: false, browserExpanded: false,
  }));
  document.documentElement.classList.add("dark");

  /* ---- 1d. vibrancy emulation ------------------------------------------- *
   * The real app is an Electron window with native macOS vibrancy: html/body/
   * #root are TRANSPARENT and the chrome (sidebar, tab bars, pane gutters) is a
   * single translucent frosted layer over the blurred desktop — that depth is a
   * big part of why it reads as "the app". In a plain browser there's no native
   * vibrancy, so the same components fall back to a flat opaque slate and look
   * dead. We recreate the effect WITHOUT touching app code:
   *   (a) add `.electron-mac` → reuses the exact real vibrancy CSS (index.css
   *       §macOS native vibrancy): root goes transparent, chrome frosts to a
   *       translucent dark glass, terminal panes ride the same layer.
   *   (b) paint a deep, cool aurora backdrop BEHIND the now-transparent root
   *       (body::before, fixed, z-index:-1) so the glass has something living
   *       to frost over — the browser-side stand-in for the blurred desktop.
   * Self-contained: looks right standalone, on the local server, and inside the
   * landing hero iframe — no dependency on the parent page bleeding through. */
  document.documentElement.classList.add("electron-mac");
  (function injectVibrancyBackdrop() {
    var css =
      "html.electron-mac, html.electron-mac body { background: transparent !important; }" +
      /* deep cool base + three soft, blurred glows ≈ a frosted dark desktop */
      "body::before{content:'';position:fixed;inset:0;z-index:-2;pointer-events:none;" +
        "background:" +
          "radial-gradient(900px circle at 14% 4%, hsl(222 92% 58% / .30), transparent 56%)," +
          "radial-gradient(820px circle at 90% 0%, hsl(258 88% 66% / .26), transparent 55%)," +
          "radial-gradient(1100px circle at 62% 112%, hsl(187 86% 54% / .18), transparent 60%)," +
          "linear-gradient(180deg, #0a0e1a 0%, #06090f 58%, #04060b 100%);}" +
      /* a second, softer glow layer so the dark glass chrome picks up cool light,
       * like the real window over a blurred desktop. STATIC on purpose: animating
       * a viewport-sized 48px-blurred layer re-rasterizes every frame and tanked
       * the renderer to ~12fps; the real vibrancy isn't animated either, and the
       * landing page's own aurora already supplies motion around the window. */
      "body::after{content:'';position:fixed;inset:-20vh -10vw;z-index:-1;pointer-events:none;" +
        "background:radial-gradient(46vw 46vw at 28% 14%, hsl(225 96% 62% / .20), transparent 62%)," +
                   "radial-gradient(42vw 42vw at 80% 82%, hsl(265 92% 68% / .16), transparent 64%);" +
        "filter:blur(48px);}";
    var s = document.createElement("style");
    s.id = "landing-vibrancy";
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  })();
  try {
    var gitCache = JSON.stringify({ status: gitStatus(), remotes: [] });
    sessionStorage.setItem("git-status-cache:" + PROJECT, gitCache);
    sessionStorage.setItem("git-status-cache:" + P2, gitCache);
    sessionStorage.setItem("git-status-cache:" + P3, gitCache);
    // ProjectSidebar sections (Files/Git/Processes) default to processes:false →
    // the running processes don't show. Expand Processes so the project context
    // (the interesting part) is visible; Git stays in the sidebar, no extra tab.
    // Files collapsed (its tree isn't the point here — Processes is the context
    // we want shown) + smaller pinned heights so that EXPANDING Git on top of
    // Processes still fits inside a stacked (≈half-height) project sidebar without
    // the sections overlapping. Pairs with the ProjectSidebar shrink fix.
    sessionStorage.setItem("sidebar-sections", JSON.stringify({ files: false, git: false, processes: true }));
    sessionStorage.setItem("project-sidebar-bottom-heights", JSON.stringify({ git: 150, processes: 120 }));
  } catch (e) {}

  /* ---- mock data builders ----------------------------------------------- */
  function gitStatus() {
    return {
      branch: "main", ahead: 2, behind: 0,
      lastCommit: { hash: "a1b2c3d", message: "feat(ui): aurora pass", author: "you", ago: "3 min ago" },
      staged: [],
      // Keep this short: when the Git section is expanded inside a stacked
      // (constrained-height) project sidebar, a long change list overflows.
      files: [
        { path: "src/components/Hero.tsx", status: "M", staged: false },
        { path: "src/lib/analytics.ts", status: "M", staged: false },
      ],
    };
  }
  function mkTask(id, text, status, order, priority, assignedTo) {
    return { id: id, text: text, status: status, kanbanOrder: order, createdAt: ISO,
      completedAt: status === "done" ? ISO : null, projectId: PROJECT, description: null,
      priority: priority || 2, assignedTo: assignedTo || null, assignedAgentId: null, assignedTopicId: null,
      claudeTaskId: null, fingerprint: null, dueDate: null, inProgressAt: null, updatedAt: ISO,
      archived: false, blocks: [], blockedBy: [], tags: [] };
  }
  var TASKS = [
    mkTask("k1", "Wire telemetry opt-in", "backlog", 0, 1),
    mkTask("k2", "Localize onboarding", "backlog", 1, 1),
    mkTask("k3", "Sign release builds", "todo", 0, 3),
    mkTask("k4", "Empty-state polish", "todo", 1, 2),
    mkTask("k5", "Ship v1.1", "in_progress", 0, 4, "claude"),
    mkTask("k6", "Landing site", "in_progress", 1, 3, "claude"),
    mkTask("k7", "Token hashing", "review", 0, 3),
    mkTask("k8", "Split panes", "done", 0, 2),
    mkTask("k9", "Auto-update", "done", 1, 2),
    mkTask("k10", "Grain + aurora", "done", 2, 1),
  ];
  function topic(id, name, icon, color) {
    return { id: id, name: name, slug: id, parentId: null, links: [], sessionKey: "s-" + id,
      color: color, icon: icon, createdAt: ISO, updatedAt: ISO, archived: false, projectPath: null };
  }
  var TOPICS = {
    "t-ship": topic("t-ship", "ship v1.1", "🚀", "#5b8cff"),
    "t-landing": topic("t-landing", "landing site", "🎨", "#7c6cff"),
    "t-auth": topic("t-auth", "auth flow", "🔒", "#22d3ee"),
    "t-bugs": topic("t-bugs", "bug triage", "🐞", "#f5a524"),
  };
  // Topics are secondary in this story — the Claude Code sessions are the value.
  // Keep just one unread topic so the sidebar leads with projects + their agents.
  var UNREAD = {
    "t-ship": { lastReadAt: ISO, unreadCount: 2 },
  };
  var SCRIPTS = [
    { processId: "p1", scriptName: "dev", command: "vite dev", projectPath: PROJECT, status: "running", pid: 4821, startedAt: ISO, ports: [5173], source: "script" },
    { processId: "p2", scriptName: "server", command: "bun server.ts", projectPath: PROJECT, status: "running", pid: 4830, startedAt: ISO, ports: [3333], source: "script" },
    { processId: "p3", scriptName: "test", command: "bun test", projectPath: PROJECT, status: "done", pid: null, startedAt: ISO, completedAt: ISO, exitCode: 0, ports: [] },
  ];
  var PROC_OUT =
    "[2m$ vite dev[0m\n\n  [32m[1mVITE[0m [2mv6.0.1[0m  ready in [1m287[0m ms\n\n" +
    "  [32m➜[0m  [1mLocal[0m:   http://localhost:5173/\n" +
    "  [32m➜[0m  [1mNetwork[0m: http://192.168.1.24:5173/\n\n" +
    "[2m9:30:14 AM[0m [36m[vite][0m hmr update /src/components/Hero.tsx\n" +
    "[2m9:30:21 AM[0m [36m[vite][0m page reload src/routes/dashboard.tsx\n" +
    "[2m9:30:32 AM[0m [32m✓[0m built client in 1.2s\n";
  var AGENTS = [
    { id: "a1", name: "Lead", role: "lead", modelPreference: "opus", maxConcurrentTasks: 3, capabilities: [], avatarEmoji: "🧭", status: "available", createdAt: ISO, updatedAt: ISO },
    { id: "a2", name: "Builder", role: "worker", modelPreference: "sonnet", maxConcurrentTasks: 2, capabilities: [], avatarEmoji: "⚙️", status: "busy", createdAt: ISO, updatedAt: ISO },
  ];
  /* Running terminal sessions. The headline value is the Claude Code agent
   * sessions ("claude-code" → Claude icon in the sidebar, grouped under their
   * project by cwd); they are what users pay for. acme-web is the open project;
   * acme-api / acme-mobile are siblings with their own running agents. */
  function ccSession(id, cwd, busy) {
    return { id: id, name: "Claude Code", title: "Claude Code", cwd: cwd, command: "claude",
      createdAt: ISO, clients: 1, busy: !!busy, type: "claude-code", kind: "claude-code" };
  }
  var SESSIONS = [
    ccSession("cc1", PROJECT, true),
    ccSession("cc2", PROJECT, true),
    { id: "sh1", name: "zsh", title: "zsh", cwd: PROJECT, command: "/bin/zsh", createdAt: ISO, clients: 1, busy: false, type: "shell", kind: "shell" },
    ccSession("cc3", P2, true),
    ccSession("cc4", P3, false),
    ccSession("cc5", P3, true),
  ];

  /* Claude Code TUI transcripts (ANSI). \x1b = ESC; xterm needs CRLF (added at
   * emit time). Generic acme-web work — no real project/user data. */
  var CLAUDE_CC1 = [
    "\x1b[38;2;217;119;87m ██████ \x1b[0m   \x1b[1mClaude Code\x1b[0m \x1b[2mv2.1.160\x1b[0m\n",
    "\x1b[38;2;217;119;87m █ ██ █ \x1b[0m   \x1b[2mOpus 4.8 (1M context)\x1b[0m\n",
    "\x1b[38;2;217;119;87m ██████ \x1b[0m   \x1b[2macme-web · main\x1b[0m\n",
    "\n",
    "\x1b[1;36m❯\x1b[0m Wire up release signing for v1.1 and run the smoke test\n",
    "\n",
    "\x1b[38;2;217;119;87m⏺\x1b[0m I'll add the signing step to the release script, then verify.\n",
    "\n",
    "\x1b[38;2;217;119;87m⏺\x1b[0m \x1b[1mRead\x1b[0m(scripts/release.ts)\n",
    "\x1b[2m  ⎿  read 84 lines\x1b[0m\n",
    "\n",
    "\x1b[38;2;217;119;87m⏺\x1b[0m \x1b[1mEdit\x1b[0m(scripts/release.ts)\n",
    "\x1b[2m  ⎿  \x1b[0m\x1b[32m+12\x1b[0m \x1b[31m−2\x1b[0m \x1b[2m· codesign + notarize step\x1b[0m\n",
    "\n",
    "\x1b[38;2;217;119;87m⏺\x1b[0m \x1b[1mBash\x1b[0m(npm run build && npm run release:sign)\n",
    "\x1b[2m  ⎿  \x1b[0m\x1b[32m✓\x1b[0m built in 2.3s \x1b[2m· signed acme-web-1.1.0.dmg\x1b[0m\n",
    "\n",
    "\x1b[38;2;217;119;87m⏺\x1b[0m Signing works end-to-end. Running the release smoke test now…\n",
    "\n",
    "\x1b[2m──────────────────────────────────────────────\x1b[0m\n",
    "\x1b[36m✻\x1b[0m \x1b[2mWorking…  (esc to interrupt · ⏵⏵ bypass permissions on)\x1b[0m\n",
  ];
  var CLAUDE_CC2 = [
    "\x1b[38;2;217;119;87m ██████ \x1b[0m   \x1b[1mClaude Code\x1b[0m \x1b[2mv2.1.160\x1b[0m\n",
    "\x1b[38;2;217;119;87m █ ██ █ \x1b[0m   \x1b[2mOpus 4.8 (1M context)\x1b[0m\n",
    "\x1b[38;2;217;119;87m ██████ \x1b[0m   \x1b[2macme-web · main\x1b[0m\n",
    "\n",
    "\x1b[1;36m❯\x1b[0m Add empty states to the dashboard lists\n",
    "\n",
    "\x1b[38;2;217;119;87m⏺\x1b[0m Scanning the dashboard route for lists missing an empty state.\n",
    "\n",
    "\x1b[38;2;217;119;87m⏺\x1b[0m \x1b[1mGrep\x1b[0m(\"\\.map(\" in src/routes/dashboard.tsx)\n",
    "\x1b[2m  ⎿  3 matches\x1b[0m\n",
    "\n",
    "\x1b[38;2;217;119;87m⏺\x1b[0m Adding <EmptyState/> to the channels, sessions and errors lists.\n",
    "\x1b[2m   esc to interrupt\x1b[0m\n",
  ];
  var CLAUDE_CC3 = [
    "\x1b[38;2;217;119;87m ██████ \x1b[0m   \x1b[1mClaude Code\x1b[0m \x1b[2mv2.1.160\x1b[0m\n",
    "\x1b[38;2;217;119;87m █ ██ █ \x1b[0m   \x1b[2mOpus 4.8 (1M context)\x1b[0m\n",
    "\x1b[38;2;217;119;87m ██████ \x1b[0m   \x1b[2macme-api · main\x1b[0m\n",
    "\n",
    "\x1b[1;36m❯\x1b[0m Add a token-bucket rate limiter to the public API\n",
    "\n",
    "\x1b[38;2;217;119;87m⏺\x1b[0m Adding middleware and wiring it into the router.\n",
    "\n",
    "\x1b[38;2;217;119;87m⏺\x1b[0m \x1b[1mWrite\x1b[0m(src/middleware/rateLimit.ts)\n",
    "\x1b[2m  ⎿  38 lines\x1b[0m\n",
    "\n",
    "\x1b[38;2;217;119;87m⏺\x1b[0m \x1b[1mBash\x1b[0m(bun test rate-limit)\n",
    "\x1b[2m  ⎿  \x1b[0m\x1b[32m✓\x1b[0m 12 passed \x1b[2m(248ms)\x1b[0m\n",
    "\n",
    "\x1b[38;2;217;119;87m⏺\x1b[0m Limiter live: 100 req/min per key. Verifying the 429 headers…\n",
    "\x1b[2m   esc to interrupt\x1b[0m\n",
  ];
  // A COMPLETED turn — agent finished, prompt is idle again (no "Working…").
  var CLAUDE_CC4 = [
    "\x1b[38;2;217;119;87m ██████ \x1b[0m   \x1b[1mClaude Code\x1b[0m \x1b[2mv2.1.160\x1b[0m\n",
    "\x1b[38;2;217;119;87m █ ██ █ \x1b[0m   \x1b[2mOpus 4.8 (1M context)\x1b[0m\n",
    "\x1b[38;2;217;119;87m ██████ \x1b[0m   \x1b[2macme-mobile · main\x1b[0m\n",
    "\n",
    "\x1b[1;36m❯\x1b[0m Fix the offline-sync race in the upload queue\n",
    "\n",
    "\x1b[38;2;217;119;87m⏺\x1b[0m Reproduced it — the flush wasn't awaiting the write lock.\n",
    "\n",
    "\x1b[38;2;217;119;87m⏺\x1b[0m \x1b[1mEdit\x1b[0m(src/sync/queue.ts)\n",
    "\x1b[2m  ⎿  \x1b[0m\x1b[32m+6\x1b[0m \x1b[31m−3\x1b[0m\n",
    "\n",
    "\x1b[38;2;217;119;87m⏺\x1b[0m \x1b[1mBash\x1b[0m(bun test sync)\n",
    "\x1b[2m  ⎿  \x1b[0m\x1b[32m✓\x1b[0m 28 passed \x1b[2m(1.1s)\x1b[0m\n",
    "\n",
    "\x1b[32m⏺\x1b[0m \x1b[1mDone\x1b[0m — offline sync is race-free and the full suite is green.\n",
    "\n",
    "\x1b[1;36m❯\x1b[0m \x1b[7m \x1b[0m\n",
  ];
  var SHELL_LINES = [
    "\x1b[2m~/code/acme-web\x1b[0m \x1b[32m✔\x1b[0m\n",
    "\x1b[1;36m❯\x1b[0m git status -sb\n",
    "## \x1b[32mmain\x1b[0m\n",
    " \x1b[31mM\x1b[0m src/components/Hero.tsx\n",
    " \x1b[31mM\x1b[0m src/lib/analytics.ts\n",
    "\x1b[1;36m❯\x1b[0m npm run dev\n",
    "\x1b[2m> acme-web@1.1.0 dev\x1b[0m\n",
    "\x1b[32m➜\x1b[0m Local:   http://localhost:5173/\n",
    "\x1b[1;36m❯\x1b[0m █\n",
  ];

  var SYSTEM_STATUS = {
    timestamp: ISO,
    gateway: { online: true, status: "online", latencyMs: 12, lastCheckedAt: ISO, url: "" },
    server: { uptimeMs: 1000000, startedAt: ISO, memoryMB: 41, heapUsedMB: 20, heapTotalMB: 40 },
    connections: { wsClients: 1, activeStreams: 0, streamKeys: [] },
    topics: { activeCount: 4, totalCount: 4 },
    cronJobs: { enabled: 0, disabled: 0, total: 0 },
    sessions: { total: 5, byType: { "claude-code": 5 } },
  };
  var GIT_DIFF =
    "diff --git a/src/components/Hero.tsx b/src/components/Hero.tsx\n" +
    "index 1a2b3c4..5d6e7f8 100644\n--- a/src/components/Hero.tsx\n+++ b/src/components/Hero.tsx\n" +
    "@@ -12,7 +12,9 @@ export function Hero() {\n   return (\n" +
    "-    <section className=\"hero\">\n+    <section className=\"hero hero--aurora\">\n+      <Grain />\n" +
    "       <h1>{title}</h1>\n       <p>{subtitle}</p>\n     </section>\n   );\n";

  /* ---- 2. fetch mock ---------------------------------------------------- */
  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  function J(v) { return new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } }); }
  function T(s) { return new Response(s, { status: 200, headers: { "content-type": "text/plain" } }); }

  window.fetch = function (input, init) {
    var u = typeof input === "string" ? input : (input && input.url) || "";
    try {
      if (/\/api\//.test(u) || /^\/api/.test(u)) {
        // text endpoints (caller does response.text())
        if (/\/git\/(diff|show)\b/.test(u)) return Promise.resolve(T(GIT_DIFF));
        if (/\/files\/content\b/.test(u)) return Promise.resolve(T("// generic preview\nexport const hello = 'world';\n"));

        // keyed ui-state: GET /api/ui-state/<key> → { value }
        var keyed = u.match(/\/api\/ui-state\/([^?]+)/);
        if (keyed) {
          var key = decodeURIComponent(keyed[1]);
          if (key === "theme") return Promise.resolve(J({ value: "dark", payload_version: 1, server_seq: 0 }));
          return Promise.resolve(J({ value: null }));
        }
        if (/\/ui-state\b/.test(u)) return Promise.resolve(J({ data: {}, meta: {} }));

        if (/\/system\/status\b/.test(u)) return Promise.resolve(J(SYSTEM_STATUS));
        if (/\/topics\/master\/sessions/.test(u)) return Promise.resolve(J({ sessions: [] }));
        if (/\/topics\/[^/]+\/messages/.test(u)) return Promise.resolve(J({ messages: [], total: 0, topicName: "" }));
        if (/\/topics\b/.test(u) && !/\/topics\//.test(u)) return Promise.resolve(J({ topics: TOPICS, workspaceProjects: [PROJECT, P2, P3] }));
        if (/\/unread\b/.test(u)) return Promise.resolve(J(UNREAD));
        if (/\/git\/status\b/.test(u)) return Promise.resolve(J(gitStatus()));
        if (/\/git\/branches\b/.test(u)) return Promise.resolve(J([{ name: "main", current: true, isRemote: false }, { name: "feat/aurora", current: false, isRemote: false }]));
        if (/\/git\/remotes\b/.test(u)) return Promise.resolve(J([{ name: "origin", fetchUrl: "git@github.com:acme/acme-web.git", pushUrl: "git@github.com:acme/acme-web.git" }]));
        if (/\/git\/diff-summary\b/.test(u)) return Promise.resolve(J({ message: "", stat: "6 files changed", files: { added: ["src/routes/dashboard.tsx"], modified: ["src/components/Hero.tsx"], deleted: [], untracked: ["scripts/seed.ts"] } }));
        if (/\/git\/(log|line-changes)\b/.test(u)) return Promise.resolve(J(/line-changes/.test(u) ? { changes: [] } : []));
        if (/\/boards\/tasks\b/.test(u)) return Promise.resolve(J({ tasks: TASKS }));
        if (/\/boards\/[^/]+\/tasks\b/.test(u)) return Promise.resolve(J({ tasks: TASKS }));
        if (/\/boards\/[^/]+\/settings\b/.test(u)) return Promise.resolve(J({ projectId: PROJECT, requireApprovalForDone: false, requireReviewBeforeDone: false, blockStatusWithPending: false, onlyLeadCanChangeStatus: false, maxAgents: 4, autoExpireHours: 0 }));
        if (/\/boards\/[^/]+\/approvals\b/.test(u)) return Promise.resolve(J({ approvals: [] }));
        if (/\/boards\/[^/]+\/memory\b/.test(u)) return Promise.resolve(J({ memory: [] }));
        if (/\/boards\/[^/]+\/archived-count\b/.test(u)) return Promise.resolve(J({ count: 0 }));
        if (/\/tags\b/.test(u)) return Promise.resolve(J({ tags: [] }));
        if (/\/scripts\/[^/]+\/output\b/.test(u)) return Promise.resolve(J({ output: PROC_OUT, offset: PROC_OUT.length, done: true, status: "running" }));
        if (/\/scripts\b/.test(u)) return Promise.resolve(J({ scripts: SCRIPTS }));
        if (/\/processes\b/.test(u)) return Promise.resolve(J([]));
        if (/\/terminal\/sessions\b/.test(u)) return Promise.resolve(J(SESSIONS));
        if (/\/agents\/profiles\b/.test(u)) return Promise.resolve(J({ profiles: AGENTS }));
        if (/\/agents\/sessions\b/.test(u)) return Promise.resolve(J({ sessions: [], total: 0, limit: 100, offset: 0 }));
        if (/\/providers\/snapshot\b/.test(u)) return Promise.resolve(J({ providers: [], defaultProvider: null, generatedAt: ISO }));
        if (/\/providers\b/.test(u)) return Promise.resolve(J({ providers: [], default: null }));
        if (/\/projects\b/.test(u)) return Promise.resolve(J({ projects: [
          { id: "p-acme",     name: "acme-web",    path: PROJECT, slug: "acme-web",    color: "#5b8cff", icon: null },
          { id: "p-acme-api", name: "acme-api",    path: P2,      slug: "acme-api",    color: "#22d3ee", icon: null },
          { id: "p-acme-mob", name: "acme-mobile", path: P3,      slug: "acme-mobile", color: "#7c6cff", icon: null },
        ] }));
        if (/\/machines\b/.test(u)) return Promise.resolve(J({ machines: [] }));
        if (/\/worktrees\b/.test(u)) return Promise.resolve(J({ worktrees: [] }));
        if (/\/webhooks\b/.test(u)) return Promise.resolve(J({ webhooks: [] }));
        if (/\/dashboard\/kpis\b/.test(u)) return Promise.resolve(J({ throughputDay: 12, throughputWeek: 64, avgCycleTimeHours: 3.2, wipCount: 4, errorRate: 0.02, tokenSpendDay: 1.4, tokenSpendWeek: 9.1, agentUtilization: 0.62, approvalTurnaroundHours: 1.1, pendingApprovals: 0 }));
        if (/\/dashboard\/timeseries\b/.test(u)) return Promise.resolve(J({ points: [] }));
        if (/\/dashboard\/agent-stats\b/.test(u)) return Promise.resolve(J({ agents: [] }));
        // MUST precede the generic /files rule: ScriptRunner does Object.entries
        // on .scripts, so this must be an OBJECT map (an array → crash).
        if (/\/files\/package-scripts\b/.test(u)) return Promise.resolve(J({
          scripts: { dev: "vite dev", build: "vite build", server: "bun server.ts", test: "bun test", lint: "eslint ." },
          engines: { node: ">=20" },
        }));
        if (/\/files\b/.test(u)) return Promise.resolve(J([
          { name: "src", type: "dir", path: PROJECT + "/src", children: [] },
          { name: "public", type: "dir", path: PROJECT + "/public", children: [] },
          { name: "package.json", type: "file", path: PROJECT + "/package.json", size: 1820 },
          { name: "README.md", type: "file", path: PROJECT + "/README.md", size: 3400 },
        ]));
        if (/\/usage\//.test(u)) return Promise.resolve(J({ records: [], summary: {} }));
        if (/\/history\//.test(u)) return Promise.resolve(J({ messages: [] }));
        if (/\/openclaw\/context\b/.test(u)) return Promise.resolve(J({ soul: null, memory: null, agents: null, tools: null, identity: null, user: null, memoryIndex: [], memoryTokens: 0, totalTokens: 0, workspacePath: PROJECT }));
        if (/\/master\/monitor\b/.test(u)) return Promise.resolve(J({ enabled: false }));

        if (/snapshot|settings|status|state|kpis|summary|monitor|count|config/i.test(u)) return Promise.resolve(J({}));
        return Promise.resolve(J([]));
      }
      if (/\/preview\//.test(u)) return Promise.resolve(J({}));
    } catch (e) { /* fall through */ }
    if (realFetch && !/\/(api|preview|ws)\b/.test(u)) return realFetch(input, init);
    return Promise.resolve(J({}));
  };

  /* ---- 3. WebSocket stub ------------------------------------------------ */
  var FRAME_B64 = "__BROWSER_FRAME_B64__";

  function StubWS(url) {
    this.url = String(url || "");
    this.readyState = 0;
    this.binaryType = "blob";
    this.bufferedAmount = 0; this.extensions = ""; this.protocol = "";
    this._on = { open: [], message: [], close: [], error: [] };
    this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
    var self = this;
    setTimeout(function () { self._open(); }, 40);
  }
  StubWS.prototype.CONNECTING = 0; StubWS.prototype.OPEN = 1; StubWS.prototype.CLOSING = 2; StubWS.prototype.CLOSED = 3;
  StubWS.CONNECTING = 0; StubWS.OPEN = 1; StubWS.CLOSING = 2; StubWS.CLOSED = 3;
  StubWS.prototype.addEventListener = function (t, fn) { (this._on[t] || (this._on[t] = [])).push(fn); };
  StubWS.prototype.removeEventListener = function (t, fn) { var a = this._on[t]; if (!a) return; var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); };
  StubWS.prototype.send = function () {};
  StubWS.prototype.close = function () { this.readyState = 3; this._emit("close", { code: 1000, reason: "", wasClean: true }); };
  StubWS.prototype._emit = function (type, ev) {
    ev = ev || {}; ev.type = type; ev.target = this; ev.currentTarget = this;
    var h = this["on" + type];
    if (typeof h === "function") { try { h.call(this, ev); } catch (e) {} }
    var a = this._on[type] || [];
    for (var i = 0; i < a.length; i++) { try { a[i].call(this, ev); } catch (e) {} }
  };
  StubWS.prototype._msg = function (data) { this._emit("message", { data: data }); };
  StubWS.prototype._open = function () {
    this.readyState = 1;
    this._emit("open", {});
    var self = this, u = this.url;
    if (/\/ws\/terminal\//.test(u)) {
      var idm = u.match(/\/ws\/terminal\/([^/?]+)/);
      var sid = idm ? idm[1] : "";
      // cc1/cc2 are Claude Code agent sessions; sh1 is a plain shell.
      var lines = sid === "cc2" ? CLAUDE_CC2 : sid === "cc3" ? CLAUDE_CC3 : sid === "cc4" ? CLAUDE_CC4 : (sid === "sh1" ? SHELL_LINES : CLAUDE_CC1);
      // Raw PTY semantics: a bare \n is line-feed only (cursor drops a row but
      // keeps its column → staircase). Emit CRLF so xterm returns to col 0.
      lines.forEach(function (l, i) { setTimeout(function () { self._msg(l.replace(/\n/g, "\r\n")); }, 120 + i * 90); });
      setTimeout(function () { self._msg(JSON.stringify({ type: "replay-end" })); }, 120 + lines.length * 90 + 40);
    } else if (/\/ws\/browser\//.test(u)) {
      setTimeout(function () { self._msg(JSON.stringify({ type: "nav", url: "https://acme.example.com/dashboard", phase: "response" })); }, 80);
      setTimeout(function () { self._msg(JSON.stringify({ type: "agent_active", active: false })); }, 90);
      setTimeout(function () { self._msg(JSON.stringify({ type: "frame", data: FRAME_B64, metadata: { timestamp: 1748856600000, pageScaleFactor: 1 } })); }, 140);
    } else {
      setTimeout(function () { self._msg(JSON.stringify({ type: "unread:init", data: UNREAD })); }, 90);
      setTimeout(function () { self._msg(JSON.stringify({ type: "terminal:sessions", sessions: SESSIONS })); }, 110);
    }
  };
  try { window.WebSocket = StubWS; } catch (e) {}
})();
