import type { Topic, UnreadData, TerminalSessionInfo } from '@/types';
import { isProjectPaneId, getProjectPathFromPaneId } from './paneConfig';

// ── Types ──────────────────────────────────────────────────────────────────────

export type SidebarItemType = 'project' | 'chat' | 'terminal' | 'browser';

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
  unreadCount: number;
  archived: boolean;
  projectPath?: string;      // for project items: the path; for children: their parent project
  children?: SidebarItem[];  // only for project items (accordion content)
  // Original data references
  topic?: Topic;
  terminal?: TerminalSessionInfo;
  browser?: BrowserContextInfo;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function getProjectLabel(projectPath: string): string {
  const dirName = projectPath.split('/').pop() || projectPath;
  return dirName;
}

function topicTimestamp(t: Topic): number {
  const ts = t.updatedAt || t.createdAt;
  return ts ? new Date(ts).getTime() : 0;
}

/** Read persisted pane IDs from a project's localStorage layout */
function readProjectPaneIds(projectPath: string): string[] {
  try {
    let hash = 0;
    for (let i = 0; i < projectPath.length; i++) {
      hash = projectPath.charCodeAt(i) + ((hash << 5) - hash);
      hash = hash & hash;
    }
    const key = `topics-project-panes-${Math.abs(hash).toString(36)}`;
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const data = JSON.parse(raw);
    // Pane IDs from nonChatPanes + chat topic IDs from openChatTopicIds
    const ids: string[] = [];
    if (Array.isArray(data.nonChatPanes)) {
      for (const p of data.nonChatPanes) if (p.id) ids.push(p.id);
    }
    if (Array.isArray(data.openChatTopicIds)) {
      for (const tid of data.openChatTopicIds) ids.push(`chat:${tid}`);
    }
    return ids;
  } catch { return []; }
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
}

export function buildSidebarItems(opts: BuildSidebarItemsOpts): SidebarItem[] {
  const { topics, workspaceProjects = [], terminalSessions = [], browserContexts = [], unreadData, showArchived, openPanels = [], projectOpenPanes = {}, lastNotifiedAt } = opts;
  const openPanelSet = new Set(openPanels);

  const items: SidebarItem[] = [];

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

  for (const ts of terminalSessions) {
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
  // A project appears if: its project pane is open, OR any child has an open tab / unread / running terminal.

  for (const pp of projectPaths) {
    const projectTopics = topicsByProject.get(pp) || [];
    const projectTerminals = terminalsByProject.get(pp) || [];
    // Collect the set of pane IDs open inside this project's ProjectWindow
    // Merge callback data (live) with persisted localStorage (for initial load)
    const callbackPanes = projectOpenPanes[pp] || [];
    const persistedPanes = readProjectPaneIds(pp);
    const internalPaneIds = new Set([...callbackPanes, ...persistedPanes]);

    // Project pane open as a top-level tab?
    const projectPaneId = `project:${encodeURIComponent(pp)}`;
    const hasProjectTab = openPanelSet.has(projectPaneId);

    const visibleTopics = showArchived ? projectTopics : projectTopics.filter(t => !t.archived);

    // Build children — only those with an open internal tab or unread
    const children: SidebarItem[] = [];

    for (const t of visibleTopics) {
      // A chat shows if its pane is open inside the project, OR has unread
      const chatPaneId = `chat:${t.id}`;
      const hasInternalTab = internalPaneIds.has(chatPaneId) || internalPaneIds.has(t.id);
      const hasTopLevelTab = openPanelSet.has(t.id);
      const hasUnread = (unreadData[t.id]?.unreadCount || 0) > 0;
      if (!t.archived && !hasInternalTab && !hasTopLevelTab && !hasUnread) continue;
      children.push({
        id: t.id,
        type: 'chat',
        name: t.name,
        icon: t.icon || '',
        lastActivity: topicTimestamp(t),
        unreadCount: unreadData[t.id]?.unreadCount || 0,
        archived: t.archived,
        projectPath: pp,
        topic: t,
      });
    }

    // Running terminals always show under their project (they're active resources)
    for (const ts of projectTerminals) {
      const termPaneId = `terminal:${ts.id}`;
      children.push({
        id: termPaneId,
        type: 'terminal',
        name: ts.name,
        icon: ts.type === 'claude-code' ? 'claude' : 'terminal',
        lastActivity: new Date(ts.createdAt).getTime(),
        unreadCount: 0,
        archived: false,
        projectPath: pp,
        terminal: ts,
      });
    }

    // Project shows if: has project tab, or has visible children
    if (!hasProjectTab && children.length === 0) continue;

    children.sort((a, b) => b.lastActivity - a.lastActivity);

    const projectActivity = children.length > 0
      ? Math.max(...children.map(c => c.lastActivity))
      : 0;
    const projectUnread = children.reduce((sum, c) => sum + c.unreadCount, 0);

    items.push({
      id: `project:${pp}`,
      type: 'project',
      name: getProjectLabel(pp),
      icon: 'folder',
      lastActivity: projectActivity,
      unreadCount: projectUnread,
      archived: false,
      projectPath: pp,
      children,
    });
  }

  // ── 3. Standalone chats ──────────────────────────────────────────────────
  // Show only if: tab is open OR has unread messages

  for (const t of standaloneChats) {
    if (t.archived && !showArchived) continue;
    // Archived items shown when showArchived is on; active items need open tab or unread
    if (!t.archived) {
      const hasTab = openPanelSet.has(t.id);
      const hasUnread = (unreadData[t.id]?.unreadCount || 0) > 0;
      if (!hasTab && !hasUnread) continue;
    }
    items.push({
      id: t.id,
      type: 'chat',
      name: t.name,
      icon: t.icon || '',
      lastActivity: topicTimestamp(t),
      unreadCount: unreadData[t.id]?.unreadCount || 0,
      archived: t.archived,
      topic: t,
    });
  }

  // ── 4. Standalone terminals ──────────────────────────────────────────────
  // Show only if terminal tab is open (running terminals with open tabs)

  for (const ts of standaloneTerminals) {
    const paneId = `terminal:${ts.id}`;
    if (!openPanelSet.has(paneId)) continue;
    items.push({
      id: paneId,
      type: 'terminal',
      name: ts.name,
      icon: ts.type === 'claude-code' ? 'claude' : 'terminal',
      lastActivity: new Date(ts.createdAt).getTime(),
      unreadCount: 0,
      archived: false,
      terminal: ts,
    });
  }

  // ── 5. Browser contexts — only if tab is open ────────────────────────────

  for (const bc of browserContexts) {
    const paneId = `browser:${bc.id}`;
    if (!openPanelSet.has(paneId)) continue;
    items.push({
      id: `browser:${bc.id}`,
      type: 'browser',
      name: bc.title || (bc.url && bc.url !== 'about:blank' ? tryHostname(bc.url) : bc.id),
      icon: 'globe',
      lastActivity: bc.lastActivity || 0,
      unreadCount: 0,
      archived: false,
      browser: bc,
    });
  }

  // ── 6. Sort: unread first (boost), then by lastActivity desc ─────────────

  items.sort((a, b) => {
    // Unread items float up
    const aHasUnread = a.unreadCount > 0 ? 1 : 0;
    const bHasUnread = b.unreadCount > 0 ? 1 : 0;
    if (aHasUnread !== bHasUnread) return bHasUnread - aHasUnread;
    // Among unread: most recently notified first
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

function tryHostname(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}
