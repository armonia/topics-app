/**
 * Who may open a tab in Attilio's bar, and how.
 *
 * Two rules, asked for on 10/11: opening a chat reuses the preview tab
 * (replaces it) and the tab stays only once he interacts with it; chats
 * started by an agent open no tab, they live in their own section (sidebar,
 * Agents, board) and are reached from there.
 *
 * On 10/11 the Jarvis project window had 47 tabs: 40 were channel and
 * scheduled-job chats nobody had opened, added on their own by the
 * "delta-add" branch of useProjectChatSync.
 */
import type { Pane, PaneGroup, Topic } from '../types';
import { findPreviewPane, replacePaneInGroup } from './previewTabs';

export { isAgentOwnedTopic } from '../../../shared/agent-owned';
import { isAgentOwnedTopic } from '../../../shared/agent-owned';

/**
 * Browser panes in a layout that belong to an agent's chat (10/11): the
 * page lives in the agent's section and is reached from its chat marker, so
 * the one-time migration takes the pane off the bar. The page itself is not
 * closed, only the tab. A browser context is the topic id, or the
 * `browserState.contextId` the topic recorded.
 */
export function agentBrowserPaneIds(
  panes: readonly Pane[],
  topics: Record<string, (Topic & { browserState?: { contextId?: string } | null }) | undefined>,
  contextOf: (paneId: string) => string | null,
): string[] {
  const owner = new Map<string, Topic>();
  for (const t of Object.values(topics)) {
    if (!t) continue;
    owner.set(t.id, t);
    const ctx = t.browserState?.contextId;
    if (ctx) owner.set(ctx, t);
  }
  const out: string[] = [];
  for (const p of panes) {
    if (p.type !== 'browser') continue;
    const ctx = contextOf(p.id);
    if (ctx && isAgentOwnedTopic(owner.get(ctx))) out.push(p.id);
  }
  return out;
}

export type ChatTabPlan =
  | { kind: 'replace-preview'; replacedPaneId: string; paneIds: string[] }
  | { kind: 'append'; paneIds: string[] };

/**
 * Where a chat opened in preview goes inside a group: in place of the
 * existing preview chat (one provisional tab per group), otherwise at the
 * end. Pinned tabs are never touched.
 */
export function planPreviewChatTab(group: PaneGroup, panes: Pane[], newPaneId: string): ChatTabPlan {
  const groupChats = group.paneIds
    .map(id => panes.find(p => p.id === id))
    .filter((p): p is Pane => !!p && p.type === 'chat');
  const preview = findPreviewPane(groupChats, newPaneId);
  if (preview) {
    return {
      kind: 'replace-preview',
      replacedPaneId: preview.id,
      paneIds: replacePaneInGroup(group.paneIds, preview.id, newPaneId),
    };
  }
  return {
    kind: 'append',
    paneIds: group.paneIds.includes(newPaneId) ? group.paneIds : [...group.paneIds, newPaneId],
  };
}

const PARKED_KEY = 'topics-agent-tabs-parked-v1:';

/**
 * One-time migration: agent chat tabs already open in a window are closed
 * the first time the window loads with this rule. Nothing is lost: the chat
 * stays alive in its section. Afterwards an agent chat Attilio opens and
 * pins stays, because the marker is already set.
 */
export function shouldParkAgentTabs(projectPath: string, storage: Pick<Storage, 'getItem'> | null): boolean {
  try { return !storage || storage.getItem(PARKED_KEY + projectPath) !== '1'; } catch { return false; }
}

const PARKED_BROWSERS_KEY = 'topics-agent-browsers-parked-v1:';

/** Same one-time migration for agent browser panes: its own marker, because
 *  windows that already ran the chat migration must still run this one. */
export function shouldParkAgentBrowsers(projectPath: string, storage: Pick<Storage, 'getItem'> | null): boolean {
  try { return !storage || storage.getItem(PARKED_BROWSERS_KEY + projectPath) !== '1'; } catch { return false; }
}

export function markAgentBrowsersParked(projectPath: string, storage: Pick<Storage, 'setItem'> | null): void {
  try { storage?.setItem(PARKED_BROWSERS_KEY + projectPath, '1'); } catch { /* retried on the next load */ }
}

export function markAgentTabsParked(projectPath: string, storage: Pick<Storage, 'setItem'> | null): void {
  try { storage?.setItem(PARKED_KEY + projectPath, '1'); } catch { /* storage full or denied: retried on the next load */ }
}
