import type { Topic, UnreadData, TerminalSessionInfo, PaneType } from '@/types';
import { isProjectPaneId, getProjectPathFromPaneId, projectPanesLocalKey, type BrowserOrigin } from '../state/pane/adapters';
import { isUtilityPanelId, parseUtilityPanelType } from '../state/pane/adapters/utilityPanelId';
import { getPaneConfig } from '../state/pane/adapters/paneConfig';
import { topicAttentionCount, terminalAttentionCount, rollupProjectAttention } from '../state/signals';
import { basename, tryHostname } from './path-utils';

// ── Types ──────────────────────────────────────────────────────────────────────

export type SidebarItemType = 'project' | 'chat' | 'terminal' | 'browser' | 'utility';

export interface BrowserContextInfo {
  id: string;
  url: string;
  title: string;
  lastActivity: number;
}

export interface SidebarItem {
  id: string;                // unique key: topic id, terminal:<id>, browser:<id>, project:<path>
  type: SidebarItemType;
  name: string;
  icon: string;              // emoji, icon name, or empty
  lastActivity: number;      // timestamp ms — used for sorting
  /** Unified attention count — chat unread OR Claude "needs you", terminal
   *  finished-turn, project rollup. Same number the tab bar badge shows for
   *  the matching pane (see signals.ts helpers). Drives the sidebar badge AND
   *  the unread-first sort. */
  notificationCount: number;
  archived: boolean;
  /** Pinned ("Fissati") — the row survives tab close (visibility gates get a
   *  pinnedIds escape) and renders in the dedicated pinned block. Set when
   *  the item's id ∈ opts.pinnedIds; render-side partitioning keys off it. */
  pinned?: boolean;
  /** Set when this topic is open in ANOTHER window (pop-out presence). Carries
   *  the Tauri window label so a click can `window_focus_label` it instead of
   *  reopening locally. Renders the trailing AppWindow glyph. */
  detachedWindowLabel?: string;
  projectPath?: string;      // for project items: the path; for children: their parent project
  children?: SidebarItem[];  // only for project items (accordion content)
  /** Sub-agents this terminal spawned (orchestrator → children). Rendered
   *  nested one level deeper than the parent terminal row. Distinct from
   *  `children` (project accordion) so project rendering never picks these up. */
  subAgents?: SidebarItem[];
  // Original data references
  topic?: Topic;
  terminal?: TerminalSessionInfo;
  browser?: BrowserContextInfo;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Friendly display label for a workspace project path — the basename
 * with the full path as a fallback if basename can't extract one
 * (e.g. relative or single-segment paths).
 *
 * Exported so every surface that shows a project name (sidebar,
 * command palette, master strip, chat tab project chip, etc.) reads
 * from one place. Don't reimplement the `.split('/').pop()` dance at
 * a call site — use this.
 */
export function getProjectLabel(projectPath: string): string {
  return basename(projectPath) || projectPath;
}

function topicTimestamp(t: Topic): number {
  const ts = t.updatedAt || t.createdAt;
  return ts ? new Date(ts).getTime() : 0;
}

/**
 * Read persisted pane IDs for a project's INNER ProjectWindow from
 * localStorage (`topics-project-panes-<hash>`). This is the only authoritative
 * source for the inner-project layout — `useProjectPersistenceSave` writes
 * the same key on every layout change.
 *
 * Previous implementation read `usePaneStore.getState().projects[path]`,
 * which captured the WRONG SCOPE (the App-level global pane store, not the
 * project's inner React state — see comment in
 * client/src/components/Layout/hooks/projectPersistence.ts:91-99 for the
 * footgun history). The pane-store path is being retired; localStorage is
 * the single source of truth for inner-project pane lists.
 *
 * `buildSidebarItems` runs inside TopicTree's useMemo, so synchronous
 * localStorage reads are fine. The memo dependency list does NOT include
 * localStorage contents, so sidebar updates driven purely by inner-project
 * edits still require the caller to pass `projectOpenPanes` callback data
 * explicitly — this function only fills the initial-render gap before the
 * first `projectOpenPanes` update lands.
 */
function readProjectPaneEntries(projectPath: string): { ids: string[]; browserTitles: Map<string, string> } {
  const browserTitles = new Map<string, string>();
  try {
    const raw = localStorage.getItem(projectPanesLocalKey(projectPath));
    if (!raw) return { ids: [], browserTitles };
    const parsed = JSON.parse(raw) as {
      nonChatPanes?: { id: string; title?: string }[];
      openChatTopicIds?: string[];
    };
    const ids: string[] = [];
    if (Array.isArray(parsed.nonChatPanes)) {
      for (const p of parsed.nonChatPanes) {
        if (!p || typeof p.id !== 'string') continue;
        ids.push(p.id);
        // A project-internal browser persists its whole Pane (incl. the page
        // title) into this localStorage blob — the global pane store never sees
        // it (see projectPersistence.ts:91-99). Lift the title so the sidebar
        // row matches the tab label, same as the store path does for top-level
        // browsers. Only browser panes carry a page title worth surfacing.
        if (p.id.startsWith('browser:') && typeof p.title === 'string' && p.title.trim()) {
          browserTitles.set(p.id, p.title.trim());
        }
      }
    }
    if (Array.isArray(parsed.openChatTopicIds)) {
      for (const tid of parsed.openChatTopicIds) {
        if (typeof tid === 'string') ids.push(`chat:${tid}`);
      }
    }
    return { ids, browserTitles };
  } catch {
    return { ids: [], browserTitles };
  }
}

// ── Builder ────────────────────────────────────────────────────────────────────

interface BuildSidebarItemsOpts {
  topics: Record<string, Topic>;
  workspaceProjects?: string[];
  terminalSessions?: TerminalSessionInfo[];
  browserContexts?: BrowserContextInfo[];
  unreadData: UnreadData;
  showArchived: boolean;
  openPanels?: string[];  // currently open pane IDs — used to filter what shows in sidebar
  projectOpenPanes?: Record<string, string[]>;  // pane IDs open inside each project (from ProjectWindow)
  lastNotifiedAt?: Map<string, number>;  // topicId → timestamp for notification sort ordering
  /** Attention signals (signals.ts) so the sidebar badge matches the tab bar:
   *  a chat where Claude needs you, or a terminal that finished a turn, counts
   *  even with zero server-unread. Default empty for callers that don't wire
   *  them (sort/render then falls back to plain unread). */
  claudeAttentionTopics?: Set<string>;
  terminalFinishedIds?: Set<string>;
  /** Pinned ("Fissati") item ids — chats by raw topic id, projects by
   *  `project:<rawPath>` (the sidebar-item id form, NOT the encoded pane id).
   *  Acts as an `||` escape at every tab-driven visibility gate (mirrors the
   *  orchestratorManaged precedent) so a pinned row survives with zero open
   *  tabs — and, for chats, even archived with showArchived off. */
  pinnedIds?: Set<string>;
  /** Topics open in ANOTHER window (pop-out presence) → {windowId, windowLabel}.
   *  Same `||` escape pattern as pinnedIds at the chat visibility gates: a topic
   *  detached elsewhere keeps its sidebar row (with an AppWindow glyph) even
   *  with no local tab. Chats only — terminals/browsers can't detach in v1. */
  detachedTopicIds?: Map<string, { windowId: string; windowLabel?: string }>;
  /** Live browser-pane titles from the GLOBAL pane store (`pane.title`), keyed by
   *  browser paneId. The server's `/api/browser/status` doesn't track the page
   *  title of native WKWebView panes, so the tab bar reads it from the store —
   *  passing it here keeps the sidebar row in lockstep with the tab. Reactive:
   *  the caller selects it with `useShallow` so a nav/scroll that leaves titles
   *  unchanged doesn't repaint the tree. Covers top-level panes; project-internal
   *  ones are lifted from localStorage inside the builder. */
  paneTitleById?: Map<string, string>;
  /** Durable origin for pinned browser paneIds whose tab is CLOSED, keyed by
   *  pane id (`browser:<ctx>`). Resolved by the caller from browserOriginStore
   *  ∪ closedStack (`resolvePinnedBrowserOrigin`). A project-inner browser is
   *  stripped from its project snapshot on close, so without this a pinned
   *  closed project browser leaks to the top-level Fissati block AND loses its
   *  title. When an entry carries a `projectPath`, the row nests back under that
   *  project; its `title`/`url` seed the label. */
  browserOriginById?: Map<string, BrowserOrigin>;
}

export function buildSidebarItems(opts: BuildSidebarItemsOpts): SidebarItem[] {
  const { topics, workspaceProjects = [], terminalSessions = [], browserContexts = [], unreadData, showArchived, openPanels = [], projectOpenPanes = {}, lastNotifiedAt, claudeAttentionTopics = new Set(), terminalFinishedIds = new Set(), pinnedIds = new Set<string>(), detachedTopicIds = new Map<string, { windowId: string; windowLabel?: string }>(), paneTitleById = new Map<string, string>(), browserOriginById = new Map<string, BrowserOrigin>() } = opts;
  const openPanelSet = new Set(openPanels);

  const items: SidebarItem[] = [];

  // Browser-pane row builder, shared by the project-children loop (nested
  // browsers) and §5 (top-level browsers). A browser pane is the only pane type
  // that surfaces in the sidebar ONLY via the open-pane set — chats/terminals
  // always appear through their topic/session rows — so it needs a row wherever
  // it's hosted. `projectInternalBrowserIds` tracks the ones emitted as project
  // children so §5 doesn't list them again at the top level.
  const browserContextById = new Map(browserContexts.map((bc) => [bc.id, bc]));
  const projectInternalBrowserIds = new Set<string>();
  // Project-internal browser titles, filled from each project's localStorage as
  // the loop visits it (populated before buildBrowserItem runs for that project).
  const projectBrowserTitles = new Map<string, string>();
  const buildBrowserItem = (paneId: string, projectPath?: string): SidebarItem => {
    const contextId = paneId.slice('browser:'.length);
    const bc = browserContextById.get(contextId);
    // Durable origin (closedStack ∪ store) for a pinned CLOSED project browser —
    // the only surviving title/url once the pane is stripped from the project
    // snapshot. Kept as a low-priority fallback so a live title always wins.
    const origin = browserOriginById.get(paneId);
    // Resolution order: persisted page title (store for top-level panes, else the
    // project-localStorage lift) → durable origin title → server context title →
    // hostname → "Browser". The persisted title is what the tab bar shows, so
    // leading with it keeps the sidebar row and the tab in sync for native panes
    // the server can't title.
    const persistedTitle = paneTitleById.get(paneId) || projectBrowserTitles.get(paneId) || origin?.title || '';
    const url = bc?.url || origin?.url || '';
    const hostname = url && url !== 'about:blank' ? tryHostname(url) : '';
    return {
      id: paneId,
      type: 'browser',
      name: persistedTitle || bc?.title || hostname || 'Browser',
      icon: 'globe',
      lastActivity: bc?.lastActivity || 0,
      notificationCount: 0,
      archived: false,
      ...(projectPath ? { projectPath } : {}),
      // Pin parity with chat/terminal/project rows: a pinned browser renders the
      // pin glyph and floats into the Fissati block. Was missing, so toggling a
      // browser pin was invisible even where the affordance existed.
      ...(pinnedIds.has(paneId) ? { pinned: true } : {}),
      browser: bc ?? { id: contextId, url: origin?.url || '', title: origin?.title || '', lastActivity: 0 },
    };
  };

  // ── 1. Group topics by project ───────────────────────────────────────────

  // Collect all known project paths (workspace + topics + open project panes)
  const projectPaths = new Set<string>(workspaceProjects);
  for (const t of Object.values(topics)) {
    if (t.projectPath) projectPaths.add(t.projectPath);
  }
  for (const id of openPanels) {
    if (isProjectPaneId(id)) {
      const pp = getProjectPathFromPaneId(id);
      if (pp) projectPaths.add(pp);
    }
  }
  // Seed pinned projects: a pinned project with no topics, no workspace entry
  // and no open pane still needs a row — the gate escape below can't emit a
  // path nobody collected. Pin keys carry the RAW path (`project:<rawPath>`),
  // and chat pins are bare topic ids, so the prefix check can't misfire.
  for (const key of pinnedIds) {
    if (key.startsWith('project:')) projectPaths.add(key.slice('project:'.length));
  }

  // Pinned browsers whose tab is CLOSED and whose durable origin points at a
  // project → nest them back under that project (children loop below) instead of
  // leaking to the top-level Fissati block (§5), and seed the owning project's
  // path so its row is emitted even if it has nothing else open. A browser still
  // open as a top-level tab is left to §5. See browserOriginStore /
  // resolvePinnedBrowserOrigin (caller-resolved into browserOriginById).
  const pinnedProjectBrowsers = new Map<string, BrowserOrigin>();
  for (const key of pinnedIds) {
    if (!key.startsWith('browser:') || openPanelSet.has(key)) continue;
    const origin = browserOriginById.get(key);
    if (origin?.projectPath) {
      pinnedProjectBrowsers.set(key, origin);
      projectPaths.add(origin.projectPath);
    }
  }

  // Group topics by project path
  const topicsByProject = new Map<string, Topic[]>();
  const standaloneChats: Topic[] = [];

  for (const t of Object.values(topics)) {
    if (t.projectPath) {
      const arr = topicsByProject.get(t.projectPath) || [];
      arr.push(t);
      topicsByProject.set(t.projectPath, arr);
    } else {
      standaloneChats.push(t);
    }
  }

  // Group terminals by project (cwd match)
  // Sort paths longest-first so /foo/bar matches before /foo
  const sortedProjectPaths = [...projectPaths].sort((a, b) => b.length - a.length);
  const terminalsByProject = new Map<string, TerminalSessionInfo[]>();
  const standaloneTerminals: TerminalSessionInfo[] = [];

  // Sub-agent map: orchestrator sessionKey → the children it spawned. A
  // terminal session's sessionKey == its id, so a child nests under the parent
  // terminal whose id == child.parentSessionKey. Children whose parent is NOT a
  // terminal (e.g. a chat orchestrator) fall through to the flat grouping below
  // so they still appear somewhere.
  const terminalById = new Map(terminalSessions.map(t => [t.id, t]));
  const subAgentsByParent = new Map<string, TerminalSessionInfo[]>();
  for (const ts of terminalSessions) {
    if (ts.parentSessionKey && terminalById.has(ts.parentSessionKey)) {
      const arr = subAgentsByParent.get(ts.parentSessionKey) || [];
      arr.push(ts);
      subAgentsByParent.set(ts.parentSessionKey, arr);
    }
  }
  const isNestedSubAgent = (ts: TerminalSessionInfo) =>
    !!ts.parentSessionKey && terminalById.has(ts.parentSessionKey);

  // Build the nested sub-agent SidebarItems for a parent terminal, recursively
  // (a sub-agent can spawn its own). Always visible — orchestrator-managed rows
  // aren't gated on an open tab the way user-opened terminals are.
  const buildSubAgentItems = (parentTerminalId: string): SidebarItem[] => {
    const kids = (subAgentsByParent.get(parentTerminalId) || [])
      .slice()
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return kids.map(ts => {
      const nested = buildSubAgentItems(ts.id);
      return {
        id: `terminal:${ts.id}`,
        type: 'terminal' as const,
        name: ts.name,
        icon: ts.type === 'claude-code' ? 'claude' : ts.type === 'codex' ? 'codex' : 'terminal',
        lastActivity: new Date(ts.createdAt).getTime(),
        notificationCount: terminalAttentionCount(ts.id, terminalFinishedIds),
        archived: false,
        terminal: ts,
        ...(nested.length ? { subAgents: nested } : {}),
      };
    });
  };

  for (const ts of terminalSessions) {
    // Sub-agents nested under a terminal parent are rendered inside that
    // parent's row (buildSubAgentItems), never as their own flat entry.
    if (isNestedSubAgent(ts)) continue;
    // Match terminal cwd to the most specific project path
    let matched = false;
    for (const pp of sortedProjectPaths) {
      if (ts.cwd === pp || ts.cwd.startsWith(pp + '/')) {
        const arr = terminalsByProject.get(pp) || [];
        arr.push(ts);
        terminalsByProject.set(pp, arr);
        matched = true;
        break;
      }
    }
    if (!matched) standaloneTerminals.push(ts);
  }

  // ── 2. Build project items ───────────────────────────────────────────────
  // Everything in the sidebar is tab-driven: only show if there's an open tab or unread.
  // A project appears if: its project pane is open, OR any child has an open tab / unread.

  for (const pp of projectPaths) {
    const projectTopics = topicsByProject.get(pp) || [];
    const projectTerminals = terminalsByProject.get(pp) || [];
    // Collect the set of pane IDs open inside this project's ProjectWindow
    // Merge callback data (live) with persisted localStorage (for initial load)
    const callbackPanes = projectOpenPanes[pp] || [];
    const { ids: persistedPanes, browserTitles: persistedBrowserTitles } = readProjectPaneEntries(pp);
    for (const [pid, title] of persistedBrowserTitles) projectBrowserTitles.set(pid, title);
    const internalPaneIds = new Set([...callbackPanes, ...persistedPanes]);

    // Project pane open as a top-level tab?
    const projectPaneId = `project:${encodeURIComponent(pp)}`;
    const hasProjectTab = openPanelSet.has(projectPaneId);

    // Pinned escape: a pinned chat stays listed even archived (a pre-feature
    // close archived it; reopen self-heals via openPanel's unarchive).
    const visibleTopics = showArchived ? projectTopics : projectTopics.filter(t => !t.archived || pinnedIds.has(t.id));

    // Build children — only those with an open internal tab or unread
    const children: SidebarItem[] = [];

    for (const t of visibleTopics) {
      // A chat shows if its pane is open inside the project, OR has a pending
      // notification (server unread or Claude needs-you) so an awaiting-approval
      // chat surfaces in the sidebar even with no open tab.
      const chatPaneId = `chat:${t.id}`;
      const hasInternalTab = internalPaneIds.has(chatPaneId) || internalPaneIds.has(t.id);
      const hasTopLevelTab = openPanelSet.has(t.id);
      const notificationCount = topicAttentionCount(t.id, unreadData, claudeAttentionTopics);
      // Pinned escape (fourth explicit exception, after archived/tab/notification):
      // a pinned chat keeps its row with the tab closed. A topic open in another
      // window (detachedTopicIds) is the fifth — same `||` escape pattern.
      if (!t.archived && !hasInternalTab && !hasTopLevelTab && notificationCount === 0 && !pinnedIds.has(t.id) && !detachedTopicIds.has(t.id)) continue;
      children.push({
        id: t.id,
        type: 'chat',
        name: t.name,
        icon: t.icon || '',
        lastActivity: topicTimestamp(t),
        notificationCount,
        archived: t.archived,
        projectPath: pp,
        topic: t,
        ...(pinnedIds.has(t.id) ? { pinned: true } : {}),
        ...(detachedTopicIds.has(t.id) ? { detachedWindowLabel: detachedTopicIds.get(t.id)!.windowLabel ?? "" } : {}),
      });
    }

    // Tab-driven, same rule as standalone terminals + project chats: a terminal
    // shows ONLY while its pane is actually open — inside this project's window
    // (internalPaneIds) or as a top-level tab (openPanelSet). Previously project
    // terminals were listed unconditionally as "active resources", so closing a
    // terminal tab left its sidebar row behind: the row tracked "session is
    // running", not "tab is open", and the PTY lingers ~60s for the undo grace.
    // Gating on the open tab makes a closed tab vanish from the sidebar
    // immediately (⌘Z within the grace window still restores tab + row); a
    // detached-but-running session stays reachable from Processes / Agents.
    for (const ts of projectTerminals) {
      const termPaneId = `terminal:${ts.id}`;
      const projSubAgents = buildSubAgentItems(ts.id);
      // Tab-driven gate, EXCEPT orchestrator-managed rows: a session that is
      // itself a sub-agent, or that has spawned sub-agents, stays visible so the
      // tree can be monitored regardless of its own open tab.
      const orchestratorManaged = !!ts.parentSessionKey || projSubAgents.length > 0;
      // Pinned escape (same `||` pattern as chats/projects): a pinned terminal
      // keeps its row inside the project even with the tab closed. Pin keys use
      // the pane-id form `terminal:<sessionId>`.
      if (!internalPaneIds.has(termPaneId) && !openPanelSet.has(termPaneId) && !orchestratorManaged && !pinnedIds.has(termPaneId)) continue;
      children.push({
        id: termPaneId,
        type: 'terminal',
        name: ts.name,
        icon: ts.type === 'claude-code' ? 'claude' : ts.type === 'codex' ? 'codex' : 'terminal',
        lastActivity: new Date(ts.createdAt).getTime(),
        notificationCount: terminalAttentionCount(ts.id, terminalFinishedIds),
        archived: false,
        projectPath: pp,
        terminal: ts,
        ...(pinnedIds.has(termPaneId) ? { pinned: true } : {}),
        ...(projSubAgents.length ? { subAgents: projSubAgents } : {}),
      });
    }

    // Browser panes opened INSIDE this project window — nested as project
    // children (same tab-driven rule via internalPaneIds). Without this a
    // project-internal browser had no sidebar row at all (it's not a topic, and
    // §5 only saw top-level openPanels).
    for (const paneId of internalPaneIds) {
      if (!paneId.startsWith('browser:')) continue;
      projectInternalBrowserIds.add(paneId);
      children.push(buildBrowserItem(paneId, pp));
    }

    // Pinned project browsers whose tab is CLOSED — nested back under their
    // origin project (durable title/url via browserOriginById) instead of
    // leaking to §5 as a top-level Fissati row. Marking them in
    // projectInternalBrowserIds keeps §5 from listing them again.
    for (const [paneId, origin] of pinnedProjectBrowsers) {
      if (origin.projectPath !== pp) continue;
      if (internalPaneIds.has(paneId) || projectInternalBrowserIds.has(paneId)) continue;
      projectInternalBrowserIds.add(paneId);
      children.push(buildBrowserItem(paneId, pp));
    }

    // Project shows if: has project tab, or has visible children — or is
    // pinned (Fissati escape; pin keys use the raw-path item id form).
    if (!hasProjectTab && children.length === 0 && !pinnedIds.has(`project:${pp}`)) continue;

    children.sort((a, b) => b.lastActivity - a.lastActivity);

    const projectActivity = children.length > 0
      ? Math.max(...children.map(c => c.lastActivity))
      : 0;
    // Central rollup — the SAME helper getProjectBadgeCount uses, so the
    // sidebar project row and the project tab always show one summed count.
    // Counts every child of the project (by topic.projectPath / terminal cwd),
    // not just the rows we chose to render, matching the tab bar.
    const projectNotifications = rollupProjectAttention(pp, topics, terminalSessions, unreadData, claudeAttentionTopics, terminalFinishedIds);

    items.push({
      id: `project:${pp}`,
      type: 'project',
      name: getProjectLabel(pp),
      icon: 'folder',
      lastActivity: projectActivity,
      notificationCount: projectNotifications,
      archived: false,
      projectPath: pp,
      children,
      ...(pinnedIds.has(`project:${pp}`) ? { pinned: true } : {}),
    });
  }

  // ── 3. Standalone chats ──────────────────────────────────────────────────
  // Show only if: tab is open OR has unread messages

  for (const t of standaloneChats) {
    // Pinned escape: a pinned chat shows even archived (pre-feature close).
    if (t.archived && !showArchived && !pinnedIds.has(t.id)) continue;
    const notificationCount = topicAttentionCount(t.id, unreadData, claudeAttentionTopics);
    // Archived items shown when showArchived is on; active items need an open
    // tab, a pending notification (unread / Claude needs-you), a pin — or being
    // open in another window (detachedTopicIds, same `||` escape).
    if (!t.archived) {
      const hasTab = openPanelSet.has(t.id);
      if (!hasTab && notificationCount === 0 && !pinnedIds.has(t.id) && !detachedTopicIds.has(t.id)) continue;
    }
    items.push({
      id: t.id,
      type: 'chat',
      name: t.name,
      icon: t.icon || '',
      lastActivity: topicTimestamp(t),
      notificationCount,
      archived: t.archived,
      topic: t,
      ...(pinnedIds.has(t.id) ? { pinned: true } : {}),
      ...(detachedTopicIds.has(t.id) ? { detachedWindowLabel: detachedTopicIds.get(t.id)!.windowLabel ?? "" } : {}),
    });
  }

  // ── 4. Standalone terminals ──────────────────────────────────────────────
  // Show only if terminal tab is open (running terminals with open tabs)

  for (const ts of standaloneTerminals) {
    const paneId = `terminal:${ts.id}`;
    const subAgents = buildSubAgentItems(ts.id);
    // A normal terminal shows only while its tab is open; but an orchestrator-
    // managed row (one that has spawned sub-agents, or is itself a sub-agent)
    // stays visible so the tree can be monitored even with its pane closed.
    const orchestratorManaged = !!ts.parentSessionKey || subAgents.length > 0;
    // Pinned escape: a pinned standalone terminal survives its tab closing,
    // same as pinned chats. Pin key is the pane-id form `terminal:<sessionId>`.
    if (!openPanelSet.has(paneId) && !orchestratorManaged && !pinnedIds.has(paneId)) continue;
    items.push({
      id: paneId,
      type: 'terminal',
      name: ts.name,
      icon: ts.type === 'claude-code' ? 'claude' : ts.type === 'codex' ? 'codex' : 'terminal',
      lastActivity: new Date(ts.createdAt).getTime(),
      notificationCount: terminalAttentionCount(ts.id, terminalFinishedIds),
      archived: false,
      terminal: ts,
      ...(pinnedIds.has(paneId) ? { pinned: true } : {}),
      ...(subAgents.length ? { subAgents } : {}),
    });
  }

  // ── 5. Browser panes — driven by `openPanels`, NOT by `browserContexts` ──
  //
  // The sidebar must mirror every open tab. Driving the loop from
  // `browserContexts` (server-side state) caused a real desync: a freshly-
  // opened pane lands in `openPanels` synchronously, but the server-side
  // context registration takes a network round-trip to come back from
  // `/api/browser/status`. During that window the tab bar shows the new
  // browser tab and the sidebar doesn't — until the next poll.
  //
  // Now we iterate every `browser:` paneId in openPanels. If a matching
  // `BrowserContextInfo` exists, use its title / url for the row label;
  // if not, fall back to "Browser". Either way the sidebar always lists
  // every open browser pane.
  // Top-level browser panes (openPanels) PLUS any pinned browser whose tab has
  // been closed — the pinned escape, mirroring standalone terminals (§4): a
  // pinned browser survives its tab closing so it stays in the Fissati block.
  // Project-internal browsers are already emitted as nested project children
  // above (projectInternalBrowserIds), so skip them here to avoid a duplicate.
  const topLevelBrowserIds = new Set<string>();
  for (const paneId of openPanelSet) {
    if (paneId.startsWith('browser:')) topLevelBrowserIds.add(paneId);
  }
  for (const paneId of pinnedIds) {
    if (paneId.startsWith('browser:')) topLevelBrowserIds.add(paneId);
  }
  for (const paneId of topLevelBrowserIds) {
    if (projectInternalBrowserIds.has(paneId)) continue;
    items.push(buildBrowserItem(paneId));
  }

  // ── 5b. Utility tabs (`__board__`, `__dashboard__`, …) — tab-driven like
  // every other row: an open utility tab gets a sidebar row, a closed one
  // doesn't. Before this, the Board generale tab was the ONE open tab with no
  // sidebar presence — "dovrebbe essere uguale per tutti il sistema". Label +
  // icon come from PANE_CONFIG (the same source the tab bar uses).
  for (const paneId of openPanelSet) {
    if (!isUtilityPanelId(paneId)) continue;
    const utilType = parseUtilityPanelType(paneId);
    if (!utilType) continue;
    const config = getPaneConfig(utilType as PaneType);
    items.push({
      id: paneId,
      type: 'utility',
      name: config.label,
      icon: config.icon,
      lastActivity: 0,
      notificationCount: 0,
      archived: false,
    });
  }

  // ── 6. Sort: notifications first (boost), then by lastActivity desc ───────

  items.sort((a, b) => {
    // Items with a pending notification float up
    const aHasUnread = a.notificationCount > 0 ? 1 : 0;
    const bHasUnread = b.notificationCount > 0 ? 1 : 0;
    if (aHasUnread !== bHasUnread) return bHasUnread - aHasUnread;
    // Among notified: most recently notified first
    if (aHasUnread && bHasUnread && lastNotifiedAt) {
      const aNotif = lastNotifiedAt.get(a.id) || 0;
      const bNotif = lastNotifiedAt.get(b.id) || 0;
      if (aNotif !== bNotif) return bNotif - aNotif;
    }
    // Then by activity
    return b.lastActivity - a.lastActivity;
  });

  return items;
}

// ── Grouped view helper ────────────────────────────────────────────────────────

export function groupSidebarItems(items: SidebarItem[]): Record<SidebarItemType, SidebarItem[]> {
  const groups: Record<SidebarItemType, SidebarItem[]> = {
    project: [],
    chat: [],
    terminal: [],
    browser: [],
    utility: [],
  };

  for (const item of items) {
    groups[item.type].push(item);
  }

  return groups;
}

// ── Search filter ──────────────────────────────────────────────────────────────

export function filterSidebarItems(items: SidebarItem[], query: string): SidebarItem[] {
  if (!query) return items;
  const q = query.toLowerCase();

  return items.reduce<SidebarItem[]>((acc, item) => {
    if (item.type === 'project') {
      // Check if project name matches
      const projectMatches = item.name.toLowerCase().includes(q);
      // Filter children
      const matchingChildren = item.children?.filter(c => c.name.toLowerCase().includes(q));

      if (projectMatches || (matchingChildren && matchingChildren.length > 0)) {
        acc.push({
          ...item,
          // If project name matches, show all children; otherwise only matching
          children: projectMatches ? item.children : matchingChildren,
        });
      }
    } else {
      if (item.name.toLowerCase().includes(q)) {
        acc.push(item);
      }
    }
    return acc;
  }, []);
}
