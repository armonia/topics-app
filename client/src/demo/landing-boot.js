/* ─────────────────────────────────────────────────────────────────────────
 * Topics landing demo — boot shim (classic script, runs BEFORE the app bundle)
 *
 * Makes the REAL Topics client run with NO backend, purely client-side:
 *   1. Seeds localStorage so the app boots straight into a dark-theme view:
 *      three PROJECT windows; the main one is a split —
 *      Claude Code terminals (left) | browser preview (right).
 *   2. Monkeypatches window.fetch to answer every /api/* call with generic
 *      mock data (endpoint URLs + shapes mirror client/src/lib/api.ts).
 *   3. Monkeypatches window.WebSocket with a stub that feeds canned frames:
 *        /ws/terminal/<id>  → ANSI shell output + replay-end
 *        /ws/browser/<id>   → nav + one screenshot frame
 *        /ws (main)         → unread:init so topics appear in the sidebar
 *
 * NOTHING here references real user/project data — it's a generic showcase.
 * Maintainability: this IS the real app bundle; only this one file is the
 * demo seam. `bun run build:site` rebuilds the demo, so a client change reaches
 * the site on the next deploy; `bun run build:landing` does it now, for dev:site.
 * ───────────────────────────────────────────────────────────────────────── */
(function () {
  "use strict";
  /* NO canvas renderer. This used to set `__TOPICS_DEMO_CANVAS__` so the Claude
   * Code block-art logo (sub-cell quadrant glyphs) rendered seam-free — but
   * @xterm/addon-canvas is pinned to xterm core v5 and CRASHES on v6 at render
   * time (`_linkifier2.onShowLinkUnderline` is undefined; the try/catch around
   * loadAddon only catches a synchronous load throw). It survived first paint
   * and then blew up the moment a terminal REMOUNTED — which is exactly what
   * switching group does — and the ErrorBoundary replaced the whole panel area
   * with "Panel error". A hairline seam in a logo is a cosmetic cost; a demo
   * that dies when you use it is not.
   * SingleTerminalPane's own comment says it outright: "never set it in the
   * app". The demo is not an exception. */
  var PROJECT = "/demo/acme-web";   // the working project (its own group)
  var P2 = "/demo/acme-api";        // sibling projects — they share the "Progetti"
  var P3 = "/demo/acme-mobile";     // group, three windows in one grid
  var P4 = "/demo/acme-docs";
  /* The demo's "now". It used to be a frozen literal, and every duration the UI
   * derives against the real clock drifted with it: by the time this build had
   * been online two months, a "live" agent session was rendering as `1515.6h`
   * and every task card was dated in the past. A shipped demo AGES, so its
   * clock has to be the visitor's. Anchored a few minutes back so the sessions
   * read as freshly active rather than started this very instant.
   * Determinism is preserved where it matters: the charts are sine-shaped, not
   * random, so only the date LABELS move. */
  var ISO = new Date(Date.now() - 4 * 60000).toISOString();

  /* THREE GROUPS, which is the model this demo exists to show: a gruppo is a
   * set of tabs you live in, and a window is just a gruppo that has been
   * detached. Spazi are that concept in the store (`Pane.spaceId` + the
   * `spaces` registry), so seeding them here is seeding real product state —
   * the sidebar (dove il gruppo AVVOLGE le sue tab) e la griglia leggono quello.
   *
   *   Principale (implicit, no record) → acme-web ALONE, one window filling the
   *                                      frame: terminals | the stage tabs.
   *   Progetti                         → acme-api + acme-mobile + acme-docs,
   *                                      three windows in one grid.
   *   Numeri                           → the standalone Board generale +
   *                                      Dashboard panes, one window, two tabs.
   *
   * A chapter navigates by SWITCHING GROUP, not by dragging dividers: the pane
   * it is about lands full-frame instead of in a quarter of a four-way split. */
  var SPACE_PROJECTS = "space:projects", SPACE_NUMBERS = "space:numbers";
  function projPaneId(p) { return "project:" + encodeURIComponent(p); }
  var PROJ_A = projPaneId(PROJECT);   // Principale, alone
  var PROJ_B = projPaneId(P2);        // Progetti, top
  var PROJ_C = projPaneId(P3);        // Progetti, bottom-left
  var PROJ_D = projPaneId(P4);        // Progetti, bottom-right
  // Inner project panes (ids unique across the app). Each project's star is a
  // Claude Code agent session (the paid core value); no standalone git pane.
  var CC1 = "terminal:cc1", CC2 = "terminal:cc2", CC3 = "terminal:cc3", CC4 = "terminal:cc4",
      CC6 = "terminal:cc6", BROW = "browser:c1";
  /* App-level utility panes (`__board__` / `__dashboard__`): these two render
   * STANDALONE — StandaloneChatGroup has a branch for them — so they can be a
   * group of their own. git / files / the per-project board cannot: they only
   * exist inside a ProjectWindow, which is why those chapters stay in the
   * acme-web group instead of getting one each. */
  var BOARD_APP = "__board__", DASH_APP = "__dashboard__";

  /* Chapter panes — the right-hand column of acme-web is the demo's STAGE.
   * Each landing "chapter" button switches this group to one of these tabs, so
   * a chapter is a REAL pane of the REAL app, reached by a real tab click — not
   * a screenshot and not a forked component. Adding a chapter here is the only
   * change needed on the app side; landing-cursor.js looks tabs up by pane id. */
  var KANB = "kanban:c1", GITP = "git:c1", FILES = "files:c1";

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
  // `spaceId` is a synced Pane field on sanitizePane's whitelist; the DEFAULT
  // group is encoded as ABSENT (never the literal id, which is normalised away).
  appPanes[PROJ_B] = { id: PROJ_B, type: "project", projectPath: P2, title: "acme-api",    stableKey: PROJ_B, spaceId: SPACE_PROJECTS };
  appPanes[PROJ_C] = { id: PROJ_C, type: "project", projectPath: P3, title: "acme-mobile", stableKey: PROJ_C, spaceId: SPACE_PROJECTS };
  appPanes[PROJ_D] = { id: PROJ_D, type: "project", projectPath: P4, title: "acme-docs",   stableKey: PROJ_D, spaceId: SPACE_PROJECTS };
  appPanes[BOARD_APP] = { id: BOARD_APP, type: "board",     title: "Board generale", stableKey: BOARD_APP, spaceId: SPACE_NUMBERS };
  appPanes[DASH_APP]  = { id: DASH_APP,  type: "dashboard", title: "Dashboard",      stableKey: DASH_APP,  spaceId: SPACE_NUMBERS };
  set("pane-store-v2", JSON.stringify({
    panes: appPanes,
    // ONE app-level group holds the tab ORDER — that is all `groups` is (there
    // is only ever `group:default`, and no renderer iterates it). The grouping
    // the user sees is `spaces` below.
    groups: { "group:default": { id: "group:default", paneIds: [PROJ_A, PROJ_B, PROJ_C, PROJ_D, BOARD_APP, DASH_APP], splitRatio: 0.5, splitAxis: "vertical" } },
    groupOrder: ["group:default"],
    // The registry: a record per NON-default group, id === its key, never a
    // record for the implicit default (sanitizeSnapshot drops that).
    spaces: {
      "space:projects": { id: SPACE_PROJECTS, name: "Progetti", order: 0, updatedAt: 1748856600000 },
      "space:numbers":  { id: SPACE_NUMBERS,  name: "Numeri",   order: 1, updatedAt: 1748856600000 },
    },
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

  /* Device-local grid overlay, PER GROUP (`topics-panel-grid-layout:<spaceId>`;
   * the bare key is the default group's). Only "Progetti" needs one: three
   * windows in a grid. The other two groups hold panes that are not solo
   * cells, so they land in the single standalone cell — which is exactly the
   * "one window filling the frame" this demo is here to show, with no drag and
   * no overlay to keep in sync.
   * The item key for a solo cell is `solo:<paneId>` (soloCells.ts soloCellKey)
   * — it MUST match or PanelGrid's additive sync re-merges everything into
   * row 0. */
  set("topics-panel-grid-layout:" + SPACE_PROJECTS, JSON.stringify({
    gridRows: [
      { itemKeys: ["solo:" + PROJ_B], widths: [1] },
      { itemKeys: ["solo:" + PROJ_C, "solo:" + PROJ_D], widths: [0.5, 0.5] },
    ],
    gridRowHeights: [0.56, 0.44],
    soloCells: [[PROJ_B], [PROJ_C], [PROJ_D]],
    soloTopicIds: [PROJ_B, PROJ_C, PROJ_D],
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
    { id: CC1,   type: "terminal",  title: "Claude Code", projectPath: PROJECT, terminalSessionId: "cc1", terminalType: "claude-code" },
    { id: CC2,   type: "terminal",  title: "Claude Code", projectPath: PROJECT, terminalSessionId: "cc2", terminalType: "claude-code" },
    { id: BROW,  type: "browser",   title: "Preview",     projectPath: PROJECT },
    // The chapter stage — one tab per landing chapter, all real panes.
    { id: KANB,  type: "kanban",    title: "Board",       projectPath: PROJECT },
    { id: GITP,  type: "git",       title: "Git",         projectPath: PROJECT },
    { id: FILES, type: "files",     title: "Files",       projectPath: PROJECT },
  ], {
    groups: [
      { id: "pgA-l", paneIds: [CC1, CC2], activePaneId: CC1,  type: "utility" },
      { id: "pgA-r", paneIds: [BROW, KANB, GITP, FILES], activePaneId: BROW, type: "utility" },
    ],
    // 42/58 in favour of the stage: this window is ALONE in its group now, so
    // the tab a chapter opens gets most of the frame without a single drag —
    // which is the whole reason a chapter switches group instead of stretching
    // a split. The terminals keep enough width for Claude Code's own wrapping.
    rows: [{ groupIds: ["pgA-l", "pgA-r"], widths: [0.42, 0.58] }],
    rowHeights: [1], sidebarCollapsed: false, focusedGroupId: "pgA-l",
  });
  seedProject(P2, [
    { id: CC3, type: "terminal", title: "Claude Code", projectPath: P2, terminalSessionId: "cc3", terminalType: "claude-code" },
  ], {
    groups: [{ id: "pgB", paneIds: [CC3], activePaneId: CC3, type: "utility" }],
    rows: [{ groupIds: ["pgB"], widths: [1] }],
    rowHeights: [1], sidebarCollapsed: true, focusedGroupId: "pgB",
  });
  // acme-mobile (P3) and acme-docs (P4): the other two windows of the
  // "Progetti" group. One working Claude Code session each; sidebar collapsed
  // so the narrow half-columns stay clean.
  seedProject(P3, [
    { id: CC4, type: "terminal", title: "Claude Code", projectPath: P3, terminalSessionId: "cc4", terminalType: "claude-code" },
  ], {
    groups: [{ id: "pgC", paneIds: [CC4], activePaneId: CC4, type: "utility" }],
    rows: [{ groupIds: ["pgC"], widths: [1] }],
    rowHeights: [1], sidebarCollapsed: true, focusedGroupId: "pgC",
  });
  seedProject(P4, [
    { id: CC6, type: "terminal", title: "Claude Code", projectPath: P4, terminalSessionId: "cc6", terminalType: "claude-code" },
  ], {
    groups: [{ id: "pgD", paneIds: [CC6], activePaneId: CC6, type: "utility" }],
    rows: [{ groupIds: ["pgD"], widths: [1] }],
    rowHeights: [1], sidebarCollapsed: true, focusedGroupId: "pgD",
  });

  /* ---- 1c. theme + misc ------------------------------------------------- */
  set("theme", JSON.stringify("dark"));
  // English, explicitly — not "auto". `resolveLocale` falls back to ITALIAN for
  // any browser that doesn't announce English, and this demo is embedded in an
  // English landing page: the language of the visitor's OS must not decide the
  // language of a marketing screenshot. (lib/settings.loadSettings reads this
  // key; useT re-resolves from it.)
  set("app-settings", JSON.stringify({ sidebarCollapsed: false, language: "en" }));
  // Expand all three projects so their Claude Code sessions are visible at a
  // glance (sidebar item id == "project:<path>", unencoded — see buildSidebarItems).
  set("topics-sidebar-state", JSON.stringify({
    expandedNodes: ["project:" + PROJECT, "project:" + P2, "project:" + P3, "project:" + P4],
    viewMode: "timeline", showArchived: false,
    showProjects: true, showChats: true, showTerminals: true,
    showProjectsArchived: false, showChatsArchived: false, browserExpanded: false,
  }));
  document.documentElement.classList.add("dark");

  /* The PWA service worker is pointless inside the demo iframe — and its
   * absolute /sw.js path 404s on the landing origin (console noise). Neuter
   * registration with a forever-pending promise: no fetch, no catch-warn. */
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.register) {
      navigator.serviceWorker.register = function () { return new Promise(function () {}); };
    }
  } catch (e) {}

  /* ---- 1d. vibrancy emulation ------------------------------------------- *
   * The real app is an Electron window with native macOS vibrancy: html/body/
   * #root are TRANSPARENT and the chrome (sidebar, tab bars, pane gutters) is a
   * single translucent frosted layer over the blurred desktop — that depth is a
   * big part of why it reads as "the app". In a plain browser there's no native
   * vibrancy, so the same components fall back to a flat opaque slate and look
   * dead. We recreate the effect WITHOUT touching app code:
   *   (a) add `.native-frost` + `.electron-mac` → reuses the exact real
   *       vibrancy CSS (index.css §Native frosted backdrop): root goes
   *       transparent, chrome frosts to a translucent dark glass, terminal
   *       panes ride the same layer. BOTH classes, because the real mac shell
   *       carries both and the rules are split between them: `native-frost`
   *       holds every translucency rule, `electron-mac` keeps the 12px #root
   *       window corner. Dropping either one would change how this demo looks.
   *   (b) paint a deep, cool aurora backdrop BEHIND the now-transparent root
   *       (body::before, fixed, z-index:-1) so the glass has something living
   *       to frost over — the browser-side stand-in for the blurred desktop.
   * Self-contained: looks right standalone, on the local server, and inside the
   * landing hero iframe — no dependency on the parent page bleeding through. */
  document.documentElement.classList.add("native-frost");
  document.documentElement.classList.add("electron-mac");
  (function injectVibrancyBackdrop() {
    var css =
      "html.native-frost, html.native-frost body { background: transparent !important; }" +
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

  /* ---- 1c-bis. Load the terminal's first-choice mono webfont ------------- *
   * The xterm panes ask for 'JetBrains Mono' first, but the app bundles no
   * webfont, so a browser without it installed falls back to Menlo — whose
   * block glyphs (the Claude Code logo ▐▛███▜▌) don't fully tile against
   * xterm's cell metrics, leaving thin "grid" lines through the logo. Pull
   * JetBrains Mono from Google Fonts so the demo terminal renders the logo
   * solid, then nudge a resize once it's ready so FitAddon re-measures the
   * cell to the real font (otherwise xterm keeps the fallback metrics). */
  (function loadTerminalFont() {
    try {
      var pre1 = document.createElement("link"); pre1.rel = "preconnect"; pre1.href = "https://fonts.googleapis.com";
      var pre2 = document.createElement("link"); pre2.rel = "preconnect"; pre2.href = "https://fonts.gstatic.com"; pre2.crossOrigin = "anonymous";
      var fl = document.createElement("link"); fl.rel = "stylesheet";
      fl.href = "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap";
      (document.head || document.documentElement).append(pre1, pre2, fl);
      if (document.fonts && document.fonts.ready) {
        document.fonts.load("14px 'JetBrains Mono'").then(function () {
          return document.fonts.ready;
        }).then(function () {
          // re-fit every mounted terminal to the now-loaded font metrics
          window.dispatchEvent(new Event("resize"));
          setTimeout(function () { window.dispatchEvent(new Event("resize")); }, 300);
        }).catch(function () {});
      }
    } catch (e) { /* font is a nicety — never block boot */ }
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
  /* Board cards are stamped a day back, not minutes back, and it is a language
   * decision rather than a cosmetic one. `fmtUpdatedAt` prints "4m fa" inside
   * the first hour and falls through to `commentTime` — a numeric dd/MM HH:MM —
   * once the card is older than twelve hours. This site is in English while the
   * board still has a handful of hardcoded Italian strings (the i18n migration
   * is in flight elsewhere), so an older stamp is the one that reads the same
   * in both languages. The live agent sessions keep their fresh timestamps:
   * those already format neutrally ("40m", "1.3h"). */
  var BOARD_ISO = new Date(Date.now() - 26 * 3600 * 1000).toISOString();
  function mkTask(id, text, status, order, priority, assignedTo, agentId, desc) {
    return { id: id, text: text, status: status, kanbanOrder: order, createdAt: BOARD_ISO,
      completedAt: status === "done" ? BOARD_ISO : null, projectId: PROJECT, description: desc || null,
      priority: priority || 2, assignedTo: assignedTo || null, assignedAgentId: agentId || null, assignedTopicId: null,
      claudeTaskId: null, fingerprint: null, dueDate: null, inProgressAt: status === "in_progress" ? BOARD_ISO : null, updatedAt: BOARD_ISO,
      archived: false, blocks: [], blockedBy: [], tags: [] };
  }
  /* The board tells the WHOLE loop in one screen: queued → an agent picked it up
   * in its own worktree → delivered and waiting for a human → landed. That arc is
   * the product's argument, so the demo board must show every stage at once. */
  var TASKS = [
    mkTask("k1", "Wire telemetry opt-in", "backlog", 0, 1),
    mkTask("k2", "Localize onboarding", "backlog", 1, 1),
    mkTask("k3", "Sign release builds", "todo", 0, 3),
    mkTask("k4", "Empty-state polish", "todo", 1, 2),
    /* Priority 2 on purpose. The card renders a priority pill only when the
     * value is hand-set and non-default (`showPriority` in Card.tsx), and that
     * pill's label is one of the strings still hardcoded in Italian. This card
     * is the one the site crops for its "Ship" image, and "Urgente" sits inline
     * before the title where no crop can avoid it. */
    mkTask("k5", "Ship v2.2 release notes", "in_progress", 0, 2, "claude", "a2", "Agent working in an isolated worktree."),
    mkTask("k6", "Landing site rebuild", "in_progress", 1, 3, "claude", "a1"),
    mkTask("k7", "Token hashing", "review", 0, 3, "claude", "a3", "Delivered — waiting for your approval."),
    mkTask("k11", "Reload-safe dispatch", "review", 1, 2, "claude", "a2"),
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
    { id: "a3", name: "Reviewer", role: "worker", modelPreference: "opus", maxConcurrentTasks: 2, capabilities: [], avatarEmoji: "🔍", status: "busy", createdAt: ISO, updatedAt: ISO },
    { id: "a4", name: "Scout", role: "worker", modelPreference: "haiku", maxConcurrentTasks: 4, capabilities: [], avatarEmoji: "🛰️", status: "available", createdAt: ISO, updatedAt: ISO },
  ];

  /* Agent sessions feed the Agents pane through TWO endpoints with DIFFERENT
   * shapes, and mixing them up crashes the pane:
   *   GET /agents/sessions          → shared/monitoring.ts `AgentSession`
   *                                   (`key`, `displayName`, `updatedAt` as an
   *                                   epoch NUMBER) — rendered as "Live".
   *   GET /agents/sessions/history  → api.ts `SessionHistoryItem`
   *                                   (`sessionKey`, `startedAt` as an ISO
   *                                   STRING) — rendered as history.
   * SessionHistory calls `new Date(s.updatedAt).toISOString()` on the live rows,
   * so a history-shaped object served on the live route throws
   * `RangeError: Invalid time value` and the ErrorBoundary eats the whole pane. */
  function liveAgentSession(key, name, status, minsAgo, tokens, msg) {
    return {
      key: key, kind: "main", channel: "topics", displayName: name, status: status,
      model: "claude-opus-5", updatedAt: Date.parse(ISO) - minsAgo * 60000,
      sessionId: key, totalTokens: tokens, contextTokens: Math.round(tokens * 0.4),
      lastMessage: msg, topicId: null, topicName: null,
    };
  }
  var LIVE_AGENT_SESSIONS = [
    liveAgentSession("sk-builder", "Builder · acme-web", "active", 1, 84000, "Writing the release notes"),
    liveAgentSession("sk-review", "Reviewer · acme-web", "active", 3, 51000, "Reading the diff"),
    liveAgentSession("sk-scout", "Scout · acme-api", "idle", 14, 22000, "Waiting for a task"),
  ];

  function histAgentSession(id, agentId, status, minsAgo, durMins, tokens) {
    var started = new Date(Date.parse(ISO) - minsAgo * 60000).toISOString();
    var ended = status === "running" ? null : new Date(Date.parse(ISO) - (minsAgo - durMins) * 60000).toISOString();
    var agent = AGENTS.filter(function (a) { return a.id === agentId; })[0] || {};
    return {
      id: id, agentId: agentId, sessionKey: "sk-" + id, topicId: null, status: status,
      taskId: null, startedAt: started, lastHeartbeat: ended || ISO, completedAt: ended,
      totalTokens: tokens, errorMessage: null,
      agentName: agent.name || "Agent", agentAvatar: agent.avatarEmoji || null,
      agentRole: agent.role || null, topicName: null,
    };
  }
  var AGENT_SESSIONS = [
    histAgentSession("s3", "a2", "completed", 96, 40, 132000),
    histAgentSession("s4", "a4", "completed", 180, 12, 22000),
    histAgentSession("s5", "a1", "completed", 260, 75, 61000),
    histAgentSession("s6", "a3", "completed", 420, 18, 44000),
  ];

  /* Dashboard series — 14 days of throughput and spend. Deterministic (no
   * Math.random) so every visitor sees the same chart and screenshots are
   * reproducible. */
  function series(base, spread, scale) {
    var pts = [], day0 = Date.parse(ISO) - 13 * 86400000;
    for (var i = 0; i < 14; i++) {
      // Cheap deterministic wobble: two out-of-phase sines, no RNG.
      var w = Math.sin(i * 1.1) * 0.6 + Math.sin(i * 0.37) * 0.4;
      var v = base + w * spread;
      pts.push({ date: new Date(day0 + i * 86400000).toISOString().slice(0, 10),
                 value: Math.round(Math.max(0, v) * scale) / scale });
    }
    return pts;
  }
  var SERIES = { throughput: series(9, 4, 1), spend: series(2.6, 1.2, 100), cycle: series(3.1, 1.1, 10) };

  /* Heartbeat timeline for the Agents chapter: a session that started, checked
   * in repeatedly, and did work. `type` must be one of TimelineEvent's union
   * members ('session_start' | 'session_end' | 'heartbeat' | 'action'). */
  var TIMELINE = (function () {
    var out = [{ type: "session_start", timestamp: new Date(Date.parse(ISO) - 26 * 60000).toISOString(), data: { model: "claude-opus-5" } }];
    for (var i = 24; i >= 2; i -= 4) {
      out.push({ type: "heartbeat", timestamp: new Date(Date.parse(ISO) - i * 60000).toISOString(),
                 data: { status: "working", tokensUsed: 8000 + (24 - i) * 3400 } });
    }
    out.push({ type: "action", timestamp: new Date(Date.parse(ISO) - 3 * 60000).toISOString(), data: { action: "commit", detail: "review: token hashing" } });
    return out;
  })();
  var AGENT_STATS = [
    { agentId: "a2", agentName: "Builder",  avatarEmoji: "⚙️", tasksCompleted: 34, totalTokens: 2410000, avgCycleTimeHours: 2.4, errorRate: 0.02, sessionsCount: 41 },
    { agentId: "a1", agentName: "Lead",     avatarEmoji: "🧭", tasksCompleted: 21, totalTokens: 1680000, avgCycleTimeHours: 3.8, errorRate: 0.01, sessionsCount: 26 },
    { agentId: "a3", agentName: "Reviewer", avatarEmoji: "🔍", tasksCompleted: 18, totalTokens: 940000,  avgCycleTimeHours: 1.2, errorRate: 0.00, sessionsCount: 22 },
    { agentId: "a4", agentName: "Scout",    avatarEmoji: "🛰️", tasksCompleted: 12, totalTokens: 310000,  avgCycleTimeHours: 0.6, errorRate: 0.03, sessionsCount: 15 },
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
    ccSession("cc6", P4, true),
  ];

  /* Claude Code TUI transcripts (ANSI). \x1b = ESC; xterm needs CRLF (added at
   * emit time). Generic acme-web work — no real project/user data.
   *
   * The mascot is the REAL Claude Code logo (v2.1.x): three rows of block-art
   * in brand orange (#D97757 foreground), the exact glyphs the CLI paints —
   * full block U+2588, right/left half U+2590/U+258C, quadrant blocks
   * U+259B–U+259D. These are SUB-CELL glyphs that only tile seam-free when the
   * renderer draws them itself; the demo loads xterm's Canvas renderer
   * (customGlyphs) for exactly this — see SingleTerminalPane, gated on the
   * `__TOPICS_DEMO_CANVAS__` flag set below. Each row is padded to 9 cells so
   * the trailing text aligns across all three lines. */
  var CC_FG = "\x1b[38;2;217;119;87m", CC_RST = "\x1b[0m";
  var M1 = CC_FG + " ▐▛███▜▌ " + CC_RST; //  ▐▛███▜▌
  var M2 = CC_FG + "▝▜█████▛▘" + CC_RST; // ▝▜█████▛▘
  var M3 = CC_FG + "  ▘▘ ▝▝  " + CC_RST; //   ▘▘ ▝▝
  var CLAUDE_CC1 = [
    M1 + "   \x1b[1mClaude Code\x1b[0m \x1b[2mv2.1.172\x1b[0m\n",
    M2 + "   \x1b[2mFable 5 (1M context)\x1b[0m\n",
    M3 + "   \x1b[2macme-web · main\x1b[0m\n",
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
    M1 + "   \x1b[1mClaude Code\x1b[0m \x1b[2mv2.1.172\x1b[0m\n",
    M2 + "   \x1b[2mFable 5 (1M context)\x1b[0m\n",
    M3 + "   \x1b[2macme-web · main\x1b[0m\n",
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
    M1 + "   \x1b[1mClaude Code\x1b[0m \x1b[2mv2.1.172\x1b[0m\n",
    M2 + "   \x1b[2mFable 5 (1M context)\x1b[0m\n",
    M3 + "   \x1b[2macme-api · main\x1b[0m\n",
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
    M1 + "   \x1b[1mClaude Code\x1b[0m \x1b[2mv2.1.172\x1b[0m\n",
    M2 + "   \x1b[2mFable 5 (1M context)\x1b[0m\n",
    M3 + "   \x1b[2macme-mobile · main\x1b[0m\n",
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
  /* acme-docs' session: a different KIND of work on purpose — the group holds
   * three projects and three agents, and three identical transcripts would
   * read as one screenshot pasted three times. */
  var CLAUDE_CC6 = [
    M1 + "   \x1b[1mClaude Code\x1b[0m \x1b[2mv2.1.172\x1b[0m\n",
    M2 + "   \x1b[2mSonnet 5\x1b[0m\n",
    M3 + "   \x1b[2macme-docs · main\x1b[0m\n",
    "\n",
    "\x1b[1;36m❯\x1b[0m Document the new webhook payload, with an example\n",
    "\n",
    "\x1b[38;2;217;119;87m⏺\x1b[0m \x1b[1mRead\x1b[0m(server/routes/webhooks.ts)\n",
    "\x1b[2m  ⎿  \x1b[0m162 lines\n",
    "\n",
    "\x1b[38;2;217;119;87m⏺\x1b[0m \x1b[1mWrite\x1b[0m(docs/webhooks.md)\n",
    "\x1b[2m  ⎿  \x1b[0m\x1b[32m+48\x1b[0m \x1b[31m−0\x1b[0m\n",
    "\n",
    "\x1b[38;2;217;119;87m⏺\x1b[0m Added the signature header and a curl example that verifies it.\n",
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
        // IDENTITY FIRST, and it has to be first. `refreshSession()` asks
        // /api/auth/session before anything else renders, and an answer without
        // `paired` means «this device was never authorised» — so the demo showed
        // the pairing screen instead of the app. It fell through to the generic
        // `J([])` at the bottom, which is exactly the failure a stale committed
        // bundle hid: the snapshot in git predated the auth gate, so nobody
        // noticed the shim had never learnt about it. Loopback + owner is what
        // the real app reports on the machine it runs on, which is the demo's
        // premise.
        if (/\/auth\/session\b/.test(u)) return Promise.resolve(J({
          paired: true, as: "loopback", name: "This Mac",
          deviceId: "demo-loopback", role: "owner", personId: null,
        }));
        if (/\/auth\/devices\b/.test(u)) return Promise.resolve(J({ devices: [], requests: [] }));
        if (/\/auth\//.test(u)) return Promise.resolve(J({}));

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
        if (/\/topics\/[^/]+\/messages/.test(u)) return Promise.resolve(J({ messages: [], total: 0, topicName: "" }));
        if (/\/topics\b/.test(u) && !/\/topics\//.test(u)) return Promise.resolve(J({ topics: TOPICS, workspaceProjects: [PROJECT, P2, P3] }));
        if (/\/unread\b/.test(u)) return Promise.resolve(J(UNREAD));
        if (/\/git\/status\b/.test(u)) return Promise.resolve(J(gitStatus()));
        if (/\/git\/branches\b/.test(u)) return Promise.resolve(J([{ name: "main", current: true, isRemote: false }, { name: "feat/aurora", current: false, isRemote: false }]));
        if (/\/git\/remotes\b/.test(u)) return Promise.resolve(J([{ name: "origin", fetchUrl: "git@github.com:acme/acme-web.git", pushUrl: "git@github.com:acme/acme-web.git" }]));
        if (/\/git\/diff-summary\b/.test(u)) return Promise.resolve(J({ message: "", stat: "6 files changed", files: { added: ["src/routes/dashboard.tsx"], modified: ["src/components/Hero.tsx"], deleted: [], untracked: ["scripts/seed.ts"] } }));
        if (/\/git\/(log|line-changes)\b/.test(u)) return Promise.resolve(J(/line-changes/.test(u) ? { changes: [] } : []));
        // `all-boards/tasks` is the cross-project feed App() reads through
        // useGlobalBoard, and it spreads the result — so the bare `[]` fallback
        // was a render-time «tasks is not iterable», i.e. a white demo. The
        // hyphen is why `/boards/tasks` never matched it.
        if (/\/(all-)?boards\/tasks\b/.test(u)) return Promise.resolve(J({ tasks: TASKS }));
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
        // ORDER MATTERS: the specific /agents/sessions/* routes must be tested
        // BEFORE the bare /agents/sessions one, which would otherwise swallow
        // them and answer every sub-route with the live-session list.
        if (/\/agents\/sessions\/history\b/.test(u)) return Promise.resolve(J({ sessions: AGENT_SESSIONS, total: AGENT_SESSIONS.length, limit: 100, offset: 0 }));
        if (/\/agents\/sessions\/[^/]+\/timeline\b/.test(u)) return Promise.resolve(J({
          session: null, events: TIMELINE, heartbeatCount: TIMELINE.length - 1, actionCount: 3,
        }));
        if (/\/agents\/sessions\/[^/]+\/history\b/.test(u)) return Promise.resolve(J({ messages: [] }));
        if (/\/agents\/profiles\/[^/]+\/sessions\b/.test(u)) return Promise.resolve(J({ sessions: AGENT_SESSIONS }));
        if (/\/agents\/profiles\b/.test(u)) return Promise.resolve(J({ profiles: AGENTS }));
        if (/\/agents\/sessions\b/.test(u)) return Promise.resolve(J({ sessions: LIVE_AGENT_SESSIONS }));
        if (/\/providers\/snapshot\b/.test(u)) return Promise.resolve(J({ providers: [], defaultProvider: null, generatedAt: ISO }));
        if (/\/providers\b/.test(u)) return Promise.resolve(J({ providers: [], default: null }));
        if (/\/projects\b/.test(u)) return Promise.resolve(J({ projects: [
          { id: "p-acme",     name: "acme-web",    path: PROJECT, slug: "acme-web",    color: "#5b8cff", icon: null },
          { id: "p-acme-api", name: "acme-api",    path: P2,      slug: "acme-api",    color: "#22d3ee", icon: null },
          { id: "p-acme-mob", name: "acme-mobile", path: P3,      slug: "acme-mobile", color: "#7c6cff", icon: null },
          { id: "p-acme-doc", name: "acme-docs",   path: P4,      slug: "acme-docs",   color: "#22c55e", icon: null },
        ] }));
        if (/\/machines\b/.test(u)) return Promise.resolve(J({ machines: [] }));
        if (/\/worktrees\b/.test(u)) return Promise.resolve(J({ worktrees: [] }));
        if (/\/webhooks\b/.test(u)) return Promise.resolve(J({ webhooks: [] }));
        if (/\/dashboard\/kpis\b/.test(u)) return Promise.resolve(J({ throughputDay: 12, throughputWeek: 64, avgCycleTimeHours: 3.2, wipCount: 4, errorRate: 0.02, tokenSpendDay: 1.4, tokenSpendWeek: 9.1, agentUtilization: 0.62, approvalTurnaroundHours: 1.1, pendingApprovals: 0 }));
        if (/\/dashboard\/timeseries\b/.test(u)) {
          // The pane asks per metric — hand back the matching series so switching
          // metric visibly redraws instead of replaying one curve for everything.
          var metric = (u.match(/metric=([^&]+)/) || [])[1] || "";
          var pts = /spend|token|cost/i.test(metric) ? SERIES.spend
                  : /cycle|time|duration/i.test(metric) ? SERIES.cycle
                  : SERIES.throughput;
          return Promise.resolve(J({ points: pts }));
        }
        if (/\/dashboard\/agent-stats\b/.test(u)) return Promise.resolve(J({ agents: AGENT_STATS }));
        // MUST precede the generic /files rule. `.scripts` is a LIST of detected
        // scripts (shared/project-scripts.ts: id/name/detail/argv/from) — it used
        // to be an object map of name → command, and this mock still said so, so
        // ScriptRunner died on `scripts.map`. Nothing caught it because the demo
        // in git was built before the change.
        if (/\/files\/package-scripts\b/.test(u)) return Promise.resolve(J({
          scripts: [
            { id: "package.json#dev",    name: "dev",    detail: "vite dev",      argv: ["bun", "run", "dev"],    from: "package.json" },
            { id: "package.json#build",  name: "build",  detail: "vite build",    argv: ["bun", "run", "build"],  from: "package.json" },
            { id: "package.json#server", name: "server", detail: "bun server.ts", argv: ["bun", "run", "server"], from: "package.json" },
            { id: "package.json#test",   name: "test",   detail: "bun test",      argv: ["bun", "run", "test"],   from: "package.json" },
            { id: "package.json#lint",   name: "lint",   detail: "eslint .",      argv: ["bun", "run", "lint"],   from: "package.json" },
          ],
          found: ["package.json"],
          looked: ["package.json", "Makefile", "Cargo.toml"],
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

        if (/snapshot|settings|status|state|kpis|summary|monitor|count|config/i.test(u)) { if (window.__DEMO_TRACE__) console.warn("[demo] fallback {} ←", u); return Promise.resolve(J({})); }
        if (window.__DEMO_TRACE__) console.warn("[demo] fallback [] ←", u);
        return Promise.resolve(J([]));
      }
      if (/\/preview\//.test(u)) return Promise.resolve(J({}));
    } catch (e) { /* fall through */ }
    if (realFetch && !/\/(api|preview|ws)\b/.test(u)) return realFetch(input, init);
    return Promise.resolve(J({}));
  };

  /* ---- 3. WebSocket stub ------------------------------------------------ */
  var FRAME_B64 = "__BROWSER_FRAME_B64__";
  /* Replaced at build time with the contents of browser-dom-snapshot.json.
   * Kept as a string literal so this file stays valid JS on its own. */
  var DOM_SNAPSHOT = "__BROWSER_DOM_SNAPSHOT__";
  if (typeof DOM_SNAPSHOT === "string") DOM_SNAPSHOT = [];   // un-substituted: skip

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
      var lines = sid === "cc2" ? CLAUDE_CC2 : sid === "cc3" ? CLAUDE_CC3 : sid === "cc4" ? CLAUDE_CC4
        : sid === "cc6" ? CLAUDE_CC6 : (sid === "sh1" ? SHELL_LINES : CLAUDE_CC1);
      // Raw PTY semantics: a bare \n is line-feed only (cursor drops a row but
      // keeps its column → staircase). Emit CRLF so xterm returns to col 0.
      lines.forEach(function (l, i) { setTimeout(function () { self._msg(l.replace(/\n/g, "\r\n")); }, 120 + i * 90); });
      setTimeout(function () { self._msg(JSON.stringify({ type: "replay-end" })); }, 120 + lines.length * 90 + 40);
    } else if (/\/ws\/browser\//.test(u)) {
      /* How this pane paints, and why it used to paint nothing.
       *
       * It has two surfaces. `video` shows a WebRTC track; `dom` (the default)
       * rebuilds the page from rrweb events in a Replayer. The JPEG below is
       * NEITHER: useRemoteBrowser treats an incoming `frame` as proof that the
       * stream is alive and explicitly never renders it. So a stub that sent
       * only a frame left the pane waiting on events that never came, and the
       * Browser chapter showed "Avvio sessione condivisa…" and nothing else.
       *
       * DOM_SNAPSHOT is a real Meta + FullSnapshot recorded from
       * src/demo/browser-page.html — the same shape the product sends over this
       * socket — so the demo replays the product's own path instead of a
       * special case. The frame still goes out, because it is the signal that
       * clears the fallback-to-polling timer. */
      setTimeout(function () { self._msg(JSON.stringify({ type: "nav", url: "https://acme.example.com/dashboard", phase: "response" })); }, 80);
      setTimeout(function () { self._msg(JSON.stringify({ type: "agent_active", active: false })); }, 90);
      setTimeout(function () { self._msg(JSON.stringify({ type: "frame", data: FRAME_B64, metadata: { timestamp: 1748856600000, pageScaleFactor: 1 } })); }, 140);
      DOM_SNAPSHOT.forEach(function (ev, i) {
        setTimeout(function () { self._msg(JSON.stringify({ type: "dom_event", event: ev })); }, 160 + i * 30);
      });
    } else {
      setTimeout(function () { self._msg(JSON.stringify({ type: "unread:init", data: UNREAD })); }, 90);
      setTimeout(function () { self._msg(JSON.stringify({ type: "terminal:sessions", sessions: SESSIONS })); }, 110);
      /* Detached windows. Window presence is deliberately NOT persisted — it is
       * fed only by `presence:windows` on the main socket — so no localStorage
       * seed can show it and looking for a key would mean inventing one. This
       * is the real channel.
       * Shape is enforced by `presenceWindowsBroadcastSchema` (shared/ws-outbound.ts)
       * BEFORE the frame reaches the bus: windowId / clientId / topicIds are
       * required, and one wrong field drops the frame in silence. The ids must
       * also differ from this tab's own `topics-window-id`, or the app reads its
       * own reflection as a second window. */
      setTimeout(function () { self._msg(JSON.stringify({
        type: "presence:windows",
        windows: [
          /* `tabs` is what the sidebar's "Finestre" groups: a window is the
           * group its tabs belong to, chats and everything else alike. A window
           * that announces only `topicIds` (an older client) still renders —
           * `windowTabs()` falls back to them — which is why the second window
           * here deliberately carries none. */
          { windowId: "w-demo-detached", clientId: "c-demo-2", windowLabel: "detach-acme-auth",
            detached: true, topicIds: ["t-auth", "t-bugs"],
            tabs: [
              { id: "t-auth", type: "chat", title: "auth flow" },
              { id: "t-bugs", type: "chat", title: "bug triage" },
              { id: "terminal:cc9", type: "terminal", title: "Claude Code" },
              { id: "browser:c9", type: "browser", title: "localhost:3000" },
            ] },
          { windowId: "w-demo-main", clientId: "c-demo-3",
            detached: false, topicIds: ["t-ship"] },
        ],
      })); }, 130);
    }
  };
  try { window.WebSocket = StubWS; } catch (e) {}
})();
