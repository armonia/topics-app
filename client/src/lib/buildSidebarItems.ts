import type { Topic, UnreadData, TerminalSessionInfo, PaneType } from '@/types';
import { isProjectPaneId, getProjectPathFromPaneId, projectPanesLocalKey, createPaneId, type BrowserOrigin } from '../state/pane/adapters';
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
  /**
   * Il pin è l'UNICA cosa che tiene su questa riga: sfissarla la fa sparire
   * dalla sidebar nello stesso fotogramma.
   *
   * Ogni cancello di visibilità qui sotto è una catena di `||` — tab aperta,
   * notifica, sotto-agente, finestra staccata, figli visibili — e il pin è
   * sempre l'ultimo anello. Quando è anche l'unico che regge, toglierlo non
   * «riporta la riga in lista»: la cancella. È un'informazione che solo questo
   * modulo ha (è lui a valutare il cancello), e senza dichiararla chi disegna
   * lo sfissaggio non può che promettere una riga che non nascerà — vedi
   * `withUnpinPreview` in TopicTree.
   *
   * Vale solo sui fissati: su una riga non fissata è sempre assente.
   */
  pinOnly?: boolean;
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

/**
 * The badge of a CHAT row. Same per-subject helper as the tab and the chrome
 * total (`topicAttentionCount`), with one rule on top: an ARCHIVED topic carries
 * 0, whatever its unread. The chrome total (`rollupGlobalAttention`) already
 * skips archived topics because nothing can switch them off: no tab to open, no
 * read to send. With "show archived" on, this row used to compute the raw count
 * and show 7 while the dock showed 0, the exact drift the shared helpers exist
 * to prevent. Visibility gates below read this value only for NON-archived
 * chats, so zeroing it here hides nothing that was visible.
 */
function chatRowAttentionCount(
  t: Topic,
  unreadData: UnreadData,
  claudeAttentionTopics: Set<string>,
): number {
  if (t.archived) return 0;
  return topicAttentionCount(t.id, unreadData, claudeAttentionTopics);
}

function topicTimestamp(t: Topic): number {
  const ts = t.updatedAt || t.createdAt;
  return ts ? new Date(ts).getTime() : 0;
}

/** A terminal's real last-activity: the Claude session's own last-touched
 *  timestamp (from `sessionLastActivityById`, keyed by terminal id — see
 *  deriveSessionLastActivity in signals.ts) when known, else its createdAt.
 *  `createdAt` alone freezes a row at session start forever — a claude-code
 *  session that ran for an hour and finished would still sort/display as if
 *  nothing happened since it was opened. `Math.max` guards against a stale
 *  Claude timestamp (e.g. race on session bootstrap) ever sorting a terminal
 *  BEFORE its own creation time. */
function terminalLastActivity(ts: TerminalSessionInfo, sessionLastActivityById: Map<string, number>): number {
  return Math.max(new Date(ts.createdAt).getTime(), sessionLastActivityById.get(ts.id) ?? 0);
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
  /** Non-chat, non-terminal pane badge counts — the SAME `extraCounts` map the
   *  tab bar reads through `getBadgeCount`'s last branch. Without it the sidebar
   *  hard-coded 0 for exactly those rows, so a pane could carry a badge on its
   *  TAB and show nothing on its sidebar row — the two surfaces disagreeing
   *  about the same pane. Threading the map through makes both read one
   *  source. */
  extraCounts?: ReadonlyMap<string, number>;
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
  /** Real last-touched timestamp per claude-code terminal session (topicId for
   *  chats isn't needed here — chats already use topicTimestamp), keyed by
   *  terminal session id, from signals.ts's deriveSessionLastActivity. Folds
   *  into every terminal row's `lastActivity` so sort order and the visible
   *  "agg. Xm fa" reflect actual Claude activity, not just when the session
   *  was created. Default empty for callers that don't wire it (falls back to
   *  createdAt, the pre-existing behavior). */
  sessionLastActivityById?: Map<string, number>;
}

export function buildSidebarItems(opts: BuildSidebarItemsOpts): SidebarItem[] {
  const { topics, workspaceProjects = [], terminalSessions = [], browserContexts = [], unreadData, showArchived, openPanels = [], projectOpenPanes = {}, lastNotifiedAt, claudeAttentionTopics = new Set(), terminalFinishedIds = new Set(), pinnedIds = new Set<string>(), extraCounts = new Map<string, number>(), detachedTopicIds = new Map<string, { windowId: string; windowLabel?: string }>(), paneTitleById = new Map<string, string>(), browserOriginById = new Map<string, BrowserOrigin>(), sessionLastActivityById = new Map<string, number>() } = opts;
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
  // `tabAperta`: la pane di questo browser è aperta ADESSO? I chiamanti lo
  // sanno per costruzione (chi arriva da `internalPaneIds` sì, chi arriva dai
  // fissati a tab chiusa no); il top-level lo chiede a `openPanelSet`. Serve
  // solo a decidere `pinOnly` — per un browser il pin è quasi sempre l'unica
  // ancora, perché non esiste nessun record che sopravviva alla pane.
  const buildBrowserItem = (paneId: string, projectPath?: string, tabAperta?: boolean): SidebarItem => {
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
      // Same `extraCounts` source as the tab (getBadgeCount's last branch).
      // Nothing badges a browser pane today, but a hard-coded 0 is how the row
      // and the tab drift apart the moment something does — the exact shape of
      // the agents-pane bug this map was threaded through to fix.
      notificationCount: extraCounts.get(paneId) ?? 0,
      archived: false,
      ...(projectPath ? { projectPath } : {}),
      // Pin parity with chat/terminal/project rows: a pinned browser renders the
      // pin glyph and floats into the Fissati block. Was missing, so toggling a
      // browser pin was invisible even where the affordance existed.
      ...(pinnedIds.has(paneId) ? { pinned: true } : {}),
      ...(pinnedIds.has(paneId) && !(tabAperta ?? openPanelSet.has(paneId)) ? { pinOnly: true } : {}),
      browser: bc ?? { id: contextId, url: origin?.url || '', title: origin?.title || '', lastActivity: 0 },
    };
  };

  // ── 1. Group topics by project ───────────────────────────────────────────

  // Collect all known project paths (workspace + topics + open project panes).
  // `standalone` topics keep a projectPath for their cwd but must NOT seed a
  // project node (catch-all "generale" agent sessions) — they render ungrouped.
  const projectPaths = new Set<string>(workspaceProjects);
  for (const t of Object.values(topics)) {
    if (t.projectPath && !t.standalone) projectPaths.add(t.projectPath);
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
    // `standalone` = ungrouped despite having a projectPath (catch-all agent
    // session): render as a top-level chat, same as a project-less topic.
    if (t.projectPath && !t.standalone) {
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

  // Sub-agent map: orchestrator → the children it spawned. A child terminal is
  // stamped with its parent's sessionKey. The parent is EITHER another terminal
  // (its sessionKey == its id) OR a CHAT topic (its sessionKey == topic.sessionKey,
  // e.g. `topic:<id>`) — a chat orchestrator that spawned sub-agents via the MCP
  // `spawn_agent` tool. BOTH cases nest the child under the parent row so the user
  // sees / monitors / navigates to it from where it was launched. Children whose
  // parent is neither (unknown/stale key) fall through to the flat grouping below
  // so they still appear somewhere.
  const terminalById = new Map(terminalSessions.map(t => [t.id, t]));
  const topicBySessionKey = new Map<string, Topic>();
  for (const t of Object.values(topics)) {
    if (t.sessionKey) topicBySessionKey.set(t.sessionKey, t);
  }
  const subAgentsByParent = new Map<string, TerminalSessionInfo[]>();      // parent is a terminal (keyed by its id)
  const subAgentsByChatParent = new Map<string, TerminalSessionInfo[]>();  // parent is a chat topic (keyed by its sessionKey)
  for (const ts of terminalSessions) {
    if (!ts.parentSessionKey) continue;
    if (terminalById.has(ts.parentSessionKey)) {
      const arr = subAgentsByParent.get(ts.parentSessionKey) || [];
      arr.push(ts);
      subAgentsByParent.set(ts.parentSessionKey, arr);
    } else if (topicBySessionKey.has(ts.parentSessionKey)) {
      const arr = subAgentsByChatParent.get(ts.parentSessionKey) || [];
      arr.push(ts);
      subAgentsByChatParent.set(ts.parentSessionKey, arr);
    }
  }
  // A child nested under EITHER a terminal or a chat parent must not ALSO be
  // emitted as its own flat row.
  const isNestedSubAgent = (ts: TerminalSessionInfo) =>
    !!ts.parentSessionKey &&
    (terminalById.has(ts.parentSessionKey) || topicBySessionKey.has(ts.parentSessionKey));

  const byCreatedAt = (a: TerminalSessionInfo, b: TerminalSessionInfo) =>
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  // Map one child terminal → a nested SidebarItem, recursing into its OWN
  // sub-agents (a sub-agent can spawn its own; those are always terminal→terminal).
  const toSubAgentItem = (ts: TerminalSessionInfo): SidebarItem => {
    const nested = buildSubAgentItems(ts.id);
    return {
      id: `terminal:${ts.id}`,
      type: 'terminal' as const,
      name: ts.name,
      icon: ts.type === 'claude-code' ? 'claude' : ts.type === 'codex' ? 'codex' : 'terminal',
      lastActivity: terminalLastActivity(ts, sessionLastActivityById),
      notificationCount: terminalAttentionCount(ts.id, terminalFinishedIds),
      archived: false,
      terminal: ts,
      ...(nested.length ? { subAgents: nested } : {}),
    };
  };
  // Nested sub-agent items for a parent TERMINAL (recursive). Always visible —
  // orchestrator-managed rows aren't gated on an open tab like user terminals.
  function buildSubAgentItems(parentTerminalId: string): SidebarItem[] {
    return (subAgentsByParent.get(parentTerminalId) || []).slice().sort(byCreatedAt).map(toSubAgentItem);
  }
  // Nested sub-agent items for a parent CHAT topic (by its sessionKey).
  const buildChatSubAgentItems = (chatSessionKey: string): SidebarItem[] =>
    (subAgentsByChatParent.get(chatSessionKey) || []).slice().sort(byCreatedAt).map(toSubAgentItem);

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
      const notificationCount = chatRowAttentionCount(t, unreadData, claudeAttentionTopics);
      // Sub-agents this chat spawned as an orchestrator (MCP spawn_agent) nest
      // under its row and keep it visible even with the tab closed, so a running
      // sub-agent is never orphaned from where it was launched.
      const chatSubAgents = buildChatSubAgentItems(t.sessionKey);
      // Pinned escape (fourth explicit exception, after archived/tab/notification):
      // a pinned chat keeps its row with the tab closed. A topic open in another
      // window (detachedTopicIds) is the fifth; a live sub-agent is the sixth —
      // same `||` escape pattern.
      if (!t.archived && !hasInternalTab && !hasTopLevelTab && notificationCount === 0 && !pinnedIds.has(t.id) && !detachedTopicIds.has(t.id) && chatSubAgents.length === 0) continue;
      // Sfissandola, resta qualcosa a tenerla su? Per una chat ARCHIVIATA no,
      // qualunque cosa abbia aperta: la taglia il filtro qui sopra (`:413`),
      // dove il pin è l'unica eccezione a «niente archiviate».
      const chatPinOnly = pinnedIds.has(t.id) && (t.archived
        ? !showArchived
        : !hasInternalTab && !hasTopLevelTab && notificationCount === 0 && !detachedTopicIds.has(t.id) && chatSubAgents.length === 0);
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
        ...(chatPinOnly ? { pinOnly: true } : {}),
        ...(detachedTopicIds.has(t.id) ? { detachedWindowLabel: detachedTopicIds.get(t.id)!.windowLabel ?? "" } : {}),
        ...(chatSubAgents.length ? { subAgents: chatSubAgents } : {}),
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
        lastActivity: terminalLastActivity(ts, sessionLastActivityById),
        notificationCount: terminalAttentionCount(ts.id, terminalFinishedIds),
        archived: false,
        projectPath: pp,
        terminal: ts,
        ...(pinnedIds.has(termPaneId) ? { pinned: true } : {}),
        ...(pinnedIds.has(termPaneId) && !internalPaneIds.has(termPaneId) && !openPanelSet.has(termPaneId) && !orchestratorManaged
          ? { pinOnly: true } : {}),
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
      children.push(buildBrowserItem(paneId, pp, true));
    }

    // Pinned project browsers whose tab is CLOSED — nested back under their
    // origin project (durable title/url via browserOriginById) instead of
    // leaking to §5 as a top-level Fissati row. Marking them in
    // projectInternalBrowserIds keeps §5 from listing them again.
    for (const [paneId, origin] of pinnedProjectBrowsers) {
      if (origin.projectPath !== pp) continue;
      if (internalPaneIds.has(paneId) || projectInternalBrowserIds.has(paneId)) continue;
      projectInternalBrowserIds.add(paneId);
      children.push(buildBrowserItem(paneId, pp, false));
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
      // Era `false` letterale, e questa riga è l'UNICO posto che costruisce un
      // item di tipo 'project': nessun consumatore lo ricalcola. Conseguenza:
      // `item.archived` non era mai vero, quindi il ramo «Ripristina progetto»
      // (bottone su hover in TopicTree, voce del menu contestuale, voce del menu
      // touch) era codice irraggiungibile — e l'unico bottone che si vedeva era
      // «Archivia», anche su un progetto in cui ogni chat era già archiviata:
      // cliccarlo ri-archiviava il già archiviato. Su questa macchina il caso
      // non è teorico: `topics-app` ha 120 topic su 120 archiviati.
      //
      // Un progetto è archiviato quando lo sono TUTTI i suoi topic — la stessa
      // definizione che usa `allArchived` a valle per decidere cosa fa il
      // bottone. Un progetto senza topic non è "archiviato": è vuoto.
      archived: projectTopics.length > 0 && projectTopics.every((t) => t.archived),
      projectPath: pp,
      children,
      ...(pinnedIds.has(`project:${pp}`) ? { pinned: true } : {}),
      // Il caso che ha fatto sparire «edm contratto»: un progetto le cui chat
      // sono tutte archiviate non ha figli visibili e, senza tab, esisteva in
      // sidebar SOLO perché fissato.
      ...(pinnedIds.has(`project:${pp}`) && !hasProjectTab && children.length === 0 ? { pinOnly: true } : {}),
    });
  }

  // ── 3. Standalone chats ──────────────────────────────────────────────────
  // Show only if: tab is open OR has unread messages

  for (const t of standaloneChats) {
    // Pinned escape: a pinned chat shows even archived (pre-feature close).
    if (t.archived && !showArchived && !pinnedIds.has(t.id)) continue;
    const notificationCount = chatRowAttentionCount(t, unreadData, claudeAttentionTopics);
    // Sub-agents this chat spawned as an orchestrator (MCP spawn_agent) — nested
    // under its row, and an escape that keeps the row visible with the tab closed.
    const chatSubAgents = buildChatSubAgentItems(t.sessionKey);
    // Archived items shown when showArchived is on; active items need an open
    // tab, a pending notification (unread / Claude needs-you), a pin, being open
    // in another window (detachedTopicIds), or a live sub-agent — same `||` escape.
    const hasTab = openPanelSet.has(t.id);
    if (!t.archived) {
      if (!hasTab && notificationCount === 0 && !pinnedIds.has(t.id) && !detachedTopicIds.has(t.id) && chatSubAgents.length === 0) continue;
    }
    // Stessa lettura del ramo dentro-progetto: archiviata, il pin è l'unica
    // deroga a «niente archiviate» (riga sopra), tab aperta o no.
    const chatPinOnly = pinnedIds.has(t.id) && (t.archived
      ? !showArchived
      : !hasTab && notificationCount === 0 && !detachedTopicIds.has(t.id) && chatSubAgents.length === 0);
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
      ...(chatPinOnly ? { pinOnly: true } : {}),
      ...(detachedTopicIds.has(t.id) ? { detachedWindowLabel: detachedTopicIds.get(t.id)!.windowLabel ?? "" } : {}),
      ...(chatSubAgents.length ? { subAgents: chatSubAgents } : {}),
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
      lastActivity: terminalLastActivity(ts, sessionLastActivityById),
      notificationCount: terminalAttentionCount(ts.id, terminalFinishedIds),
      archived: false,
      terminal: ts,
      ...(pinnedIds.has(paneId) ? { pinned: true } : {}),
      ...(pinnedIds.has(paneId) && !openPanelSet.has(paneId) && !orchestratorManaged ? { pinOnly: true } : {}),
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
    // 'board' is the ONE utility with a dedicated sidebar row of its own (the
    // "Board generale" shortcut at the top of the tree, which also carries the
    // open-task count). Emitting a generic row here too gave it TWO identical
    // "Board generale" entries the moment you opened it — one pinned at the
    // top, one appended at the bottom / in Strumenti ("non ha bisogno di avere
    // anche una ulteriore tab sotto"). The dedicated row is tab-aware, so it
    // covers what this loop existed to guarantee: an open tab is visible in the
    // sidebar.
    if (utilType === 'board') continue;
    const config = getPaneConfig(utilType as PaneType);
    items.push({
      id: paneId,
      type: 'utility',
      name: config.label,
      icon: config.icon,
      lastActivity: 0,
      // Same source as the tab. The row used to be a hard 0, so the two
      // surfaces disagreed about the very same pane.
      notificationCount: extraCounts.get(paneId) ?? 0,
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

// ── Appartenenza al GRUPPO ─────────────────────────────────────────────────────

/**
 * La pane a cui una riga corrisponde.
 *
 * `item.id` è la chiave di RENDER e per quasi tutti i tipi coincide con l'id
 * della pane (`terminal:<id>`, `browser:<ctx>`, `__board__`, l'uuid della
 * topic). L'eccezione è il progetto: la riga è chiavata sul path GREZZO
 * (`project:/Users/…`) mentre la pane usa il path CODIFICATO
 * (`project:%2FUsers%2F…`). Confonderli significa non riconoscere mai un
 * progetto come tab di un gruppo — cioè il bug che questa funzione esiste per
 * non fare.
 */
export function sidebarItemPaneId(item: SidebarItem): string {
  if (item.type === 'project' && item.projectPath) return createPaneId('project', item.projectPath);
  return item.id;
}

export interface SpaceGrouping {
  /** Le righe di ciascun gruppo, per id di gruppo, NELL'ORDINE che avevano. */
  bySpace: Map<string, SidebarItem[]>;
  /** Righe che non sono la tab di nessun gruppo: compaiono per un segnale
   *  (non letto, "attende te", un fissato) senza avere una pane aperta da
   *  nessuna parte. Vanno disegnate fuori dalle card — aprirne una la fa
   *  entrare nel gruppo attivo, e da lì in poi vive lì. */
  loose: SidebarItem[];
}

/**
 * Smista le righe della sidebar nel gruppo a cui appartengono.
 *
 * Perché serve. La sidebar è guidata dalle tab, ma con parecchie vie di fuga:
 * una chat con non letti, un progetto con un figlio che ti aspetta, un
 * terminale orchestratore compaiono ANCHE senza tab aperta. Senza questo
 * smistamento ogni gruppo mostrava la stessa lista di tutti — l'intestazione
 * diceva "Principale" e sotto c'era il progetto di un altro gruppo con le sue
 * sessioni, cioè il gruppo era un'etichetta appoggiata su una lista che non
 * governava.
 *
 * `paneSpaceById` mappa la PANE al suo gruppo: chi non è una pane aperta non
 * sta in nessun gruppo, e finisce in `loose`.
 *
 * Pura di proposito, come tutto questo file: una mappa in ingresso, nessuno
 * store.
 */
export function groupSidebarItemsBySpace(
  items: SidebarItem[],
  paneSpaceById: ReadonlyMap<string, string>,
): SpaceGrouping {
  const bySpace = new Map<string, SidebarItem[]>();
  const loose: SidebarItem[] = [];
  for (const item of items) {
    const spaceId = paneSpaceById.get(sidebarItemPaneId(item));
    if (!spaceId) { loose.push(item); continue; }
    const bucket = bySpace.get(spaceId);
    if (bucket) bucket.push(item);
    else bySpace.set(spaceId, [item]);
  }
  return { bySpace, loose };
}

// ── Raggruppamento per STATO ───────────────────────────────────────────────────
//
// Perché serve. La sidebar ordina con
// un boost BINARIO sulle notifiche: chi ha `notificationCount > 0` sale, e basta.
// Quel boost non distingue le tre cose che l'utente distingue eccome — "aspetta
// una mia risposta", "ha finito e non l'ho ancora guardato", "sta lavorando" —
// e le mescola nello stesso blocco insieme a tutto ciò che ha un numero addosso.
//
// La partizione a tre bucket esiste già, ma solo come CONTEGGI:
// `useAgentActivityCounts` (state/signals.ts) la calcola per i tre chip della
// status bar e butta via le liste. Qui la stessa partizione produce gli item.
//
// Pura di proposito: i Set arrivano dal chiamante, così è provabile senza store
// né WS — come tutto il resto di questo file.

/** I tre stati in cui la sidebar raggruppa. L'ordine è la priorità di lettura. */
export type SidebarStateBucket = 'awaiting' | 'working' | 'rest';

/** I segnali per-soggetto che decidono il bucket. Nomi identici a quelli dello
 *  store, così il call site non deve tradurre. */
export interface SidebarStateSignals {
  /** topic la cui sessione è parcheggiata in attesa dell'umano (ambra + blu). */
  awaitingTopics: ReadonlySet<string>;
  /** i gemelli terminale degli awaiting. */
  awaitingTermIds: ReadonlySet<string>;
  /** topic con un turno in corso (stream vivo o idratato). */
  workingTopics: ReadonlySet<string>;
  /** terminali con un turno in corso. */
  workingTermIds: ReadonlySet<string>;
}

/**
 * Il soggetto di un item, cioè la chiave con cui i Set dei segnali lo conoscono.
 *
 * Non è `item.id`: quello è la chiave di RENDER (`terminal:<id>`, `project:<path>`,
 * l'uuid della topic), mentre i segnali sono chiavati per SOGGETTO (topicId per le
 * chat, terminalSessionId per i terminali). Confonderli è il modo per ottenere
 * bucket sempre vuoti senza un errore.
 */
export function sidebarItemSubject(item: SidebarItem): string | null {
  if (item.type === 'chat') return item.topic?.id ?? item.id;
  if (item.type === 'terminal') return item.terminal?.id ?? null;
  return null;
}

/**
 * In quale bucket sta un item.
 *
 * "Attende te" PRECEDE "al lavoro": se una sessione è in attesa, che stia anche
 * macinando qualcosa non cambia cosa devi fare tu. I due assi sono dichiarati
 * mutuamente esclusivi nel tempo in signals.ts, ma un ordine esplicito qui evita
 * che una sovrapposizione momentanea sposti una riga sotto gli occhi dell'utente.
 *
 * Un item senza soggetto (progetto, browser, utility) sta in 'rest': un progetto
 * è un contenitore, e i suoi figli finiscono nei bucket per conto proprio.
 */
export function sidebarItemState(item: SidebarItem, sig: SidebarStateSignals): SidebarStateBucket {
  const subject = sidebarItemSubject(item);
  if (!subject) return 'rest';
  if (item.type === 'chat') {
    if (sig.awaitingTopics.has(subject)) return 'awaiting';
    if (sig.workingTopics.has(subject)) return 'working';
    return 'rest';
  }
  if (sig.awaitingTermIds.has(subject)) return 'awaiting';
  if (sig.workingTermIds.has(subject)) return 'working';
  return 'rest';
}

/**
 * Partiziona gli item nei tre bucket, PRESERVANDO l'ordine relativo che avevano.
 *
 * Preservarlo conta: `buildSidebarItems` li ha già ordinati per notifica e
 * attività, e riordinare dentro il bucket butterebbe via quel lavoro — un utente
 * che rilegge la stessa lista non deve trovare le righe rimescolate.
 *
 * I FIGLI DEI PROGETTI vengono promossi. `sidebarItemState` dice, in un commento,
 * che «un progetto è un contenitore, e i suoi figli finiscono nei bucket per
 * conto proprio»: non era vero. Questa funzione iterava solo gli item top-level,
 * mentre le chat e i terminali di un progetto vivono in `item.children` — quindi
 * la sezione «Attende te» era strutturalmente cieca a tutto ciò che sta dentro un
 * progetto, cioè alla maggior parte del lavoro. Un progetto con dentro una chat
 * che ti aspetta finiva in «Il resto» insieme a tutto il resto.
 *
 * Il figlio promosso resta contestualizzato (porta il suo `projectPath`), e il
 * progetto rimane in `rest` con i soli figli che non sono stati promossi: la
 * riga non sparisce, si svuota di ciò che ora è mostrato altrove.
 */
export function groupSidebarItemsByState(
  items: SidebarItem[],
  sig: SidebarStateSignals,
): Record<SidebarStateBucket, SidebarItem[]> {
  const groups: Record<SidebarStateBucket, SidebarItem[]> = { awaiting: [], working: [], rest: [] };
  for (const item of items) {
    if (item.type === 'project' && item.children?.length) {
      const remaining: SidebarItem[] = [];
      for (const child of item.children) {
        const bucket = sidebarItemState(child, sig);
        if (bucket === 'rest') remaining.push(child);
        else groups[bucket].push(child);
      }
      // Il progetto sta sempre in `rest`: non ha soggetto proprio, e il suo stato
      // era già quello. Cambia solo cosa gli resta appeso sotto.
      groups.rest.push(remaining.length === item.children.length ? item : { ...item, children: remaining });
      continue;
    }
    groups[sidebarItemState(item, sig)].push(item);
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
