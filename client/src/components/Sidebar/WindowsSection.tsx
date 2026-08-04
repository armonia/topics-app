// WindowsSection — "what's open in which WINDOW", the sidebar's view of the
// detach model.
//
// A group here is a WINDOW, not a split cell: the unit that gets popped out
// ("Stacca il gruppo in una nuova finestra") and lives on as its own OS window.
// The intra-window split layout is deliberately NOT represented — a pane split
// in two is still one window, and showing cells here made the sidebar describe
// geometry instead of the thing the user reasons about.
//
// Rows: this window first, then EVERY other one (main window included, not just
// detached ones — see computeOtherWindows). Click a foreign window → focus it
// natively when it's a real OS window; if it's gone / on another machine, fall
// back to reopening its topics here.
//
// ONE RULE for every row: a window is described by the TABS it holds — all of
// them, chat or not. It used to list chat topics only, which meant a window
// made of three terminals and a project announced nothing and drew as a heading
// over an empty list, and the count in the tooltip disagreed with what the
// window actually held. The presence channel now carries every tab (id, type,
// title), so the same rule applies to our own row and every peer's: same
// filter, same shape, comparable rows.
//
// Zero chrome when there is nothing to disambiguate: with a single window the
// section renders nothing (the tree below already lists those tabs).
import { useMemo, useState } from 'react';
import {
  AppWindow, BarChart3, ChevronDown, ChevronRight, Clock, Cpu, FolderOpen,
  Globe, Kanban, LayoutGrid, MessageSquare, Monitor, TerminalSquare, type LucideIcon,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { focusOrReopenDetachedWindow, topicNamesLabel } from '@/lib/detachedWindow';
import { useOtherWindows, windowTabs, type PresenceWindowTab } from '@/state/windowPresence';
import { useWorkspaceGroups } from '@/state/workspaceGroups';
import { usePaneStore } from '@/state/pane/store';
import { getPaneConfig } from '@/state/pane/adapters/paneConfig';
import type { PaneType } from '@/state/pane/types';
import type { Topic } from '@/types';

interface WindowsSectionProps {
  topics: Record<string, Topic>;
  /**
   * Focus a tab held by THIS window, BY PANE ID — not by topic id.
   * The rows list every kind of pane now, and the topic-click funnel would
   * register `project:%2Fsrv%2Facme` as a chat topic and open a "Topic non
   * trovato" tab. This one routes a pane id that is already open straight to
   * focus (usePanelLifecycle's handleFocusPanel).
   */
  onFocusTab: (paneId: string) => void;
  /** Reopen a topic locally when another window can't be focused (dead / remote). */
  onReopenTopic: (topicId: string) => void;
}

/** One glyph per pane kind, so a row is readable without opening it. */
const TAB_ICONS: Record<string, LucideIcon> = {
  chat: MessageSquare,
  terminal: TerminalSquare,
  'process-log': TerminalSquare,
  browser: Globe,
  project: FolderOpen,
  files: FolderOpen,
  kanban: Kanban,
  board: Kanban,
  dashboard: BarChart3,
  agents: Cpu,
  cron: Clock,
};

/** Field separator for the tab snapshot string — see localEncoded below. */
const SEP = '\u0001';

/** The name to show for a tab: the topic's own name for a chat, the tab title
 *  otherwise, and the pane kind's label when a window announced neither. */
function tabLabel(tab: PresenceWindowTab, topics: Record<string, Topic>): string {
  const topic = topics[tab.id];
  if (topic) return topic.name || topic.icon || tab.id;
  if (tab.title) return tab.title;
  // A chat we cannot resolve is still worth naming by its id — that is what
  // this section did before, and "Chat" three times in a row identifies
  // nothing. For every other kind the pane label IS the useful name.
  return tab.type === 'chat' ? tab.id : getPaneConfig(tab.type as PaneType).label;
}

export function WindowsSection({ topics, onFocusTab, onReopenTopic }: WindowsSectionProps) {
  const groups = useWorkspaceGroups();
  const others = useOtherWindows();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const localIds = useMemo(() => groups.flatMap((g) => g.paneIds), [groups]);
  // Encoded as flat STRINGS, decoded below. Subscribing to `s.panes` directly
  // would re-render this section on every pane write — `setPaneScrollOffset`
  // does one every 250ms while a chat scrolls — because Immer hands back a new
  // `panes` identity each time. The encoded snapshot only changes when a tab is
  // added, removed, renamed or retyped. (Same trap, same fix, as
  // usePanelLifecycle's `visibleFromStore`.)
  const localEncoded = usePaneStore(
    useShallow((s) => localIds.map((id) => {
      const p = s.panes[id];
      return [id, p?.type ?? 'chat', p?.title ?? ''].join(SEP);
    })),
  );
  const localTabs = useMemo<PresenceWindowTab[]>(
    () => localEncoded.map((enc) => {
      const [id, type, ...rest] = enc.split(SEP);
      const title = rest.join(SEP);
      return title ? { id, type, title } : { id, type };
    }),
    [localEncoded],
  );

  // Nothing else is open → nothing to place. Stay invisible rather than
  // duplicate the whole tree under a "this window" heading.
  if (others.length === 0) return null;

  const rows = [
    {
      id: 'self',
      label: 'Questa finestra',
      tabs: localTabs,
      isSelf: true,
      onActivate: undefined as (() => void) | undefined,
    },
    ...others.map((w) => ({
      id: w.windowId,
      // A non-detached peer is the window everything was torn off from; naming
      // it by its topics would read like just another cluster.
      label: w.detached
        ? topicNamesLabel(w.topicIds, topics) || 'Finestra'
        : 'Finestra principale',
      tabs: windowTabs(w),
      isSelf: false,
      // Only a real OS window (Tauri label) can be raised. A peer without one
      // (a browser tab, another device) gets no "Vai" — offering a button that
      // silently reopened its topics HERE would move work, not navigate to it.
      onActivate: w.windowLabel
        ? () => focusOrReopenDetachedWindow(w, onReopenTopic)
        : undefined,
    })),
  ];

  return (
    <div className="px-2 pt-2 pb-1" data-testid="sidebar-windows">
      <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wider text-app-text-tertiary">
        Finestre
      </div>
      <div className="flex flex-col gap-0.5">
        {rows.map((row) => {
          const isCollapsed = collapsed[row.id] ?? false;
          const Icon = row.isSelf ? Monitor : AppWindow;
          return (
            <div key={row.id}>
              <div className="group flex w-full items-center gap-1 rounded-md px-1 text-[13px] text-app-text transition-colors hover:bg-app-hover">
                <button
                  onClick={() => setCollapsed((c) => ({ ...c, [row.id]: !isCollapsed }))}
                  className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left"
                  aria-expanded={!isCollapsed}
                  title={`${row.tabs.length} ${row.tabs.length === 1 ? 'scheda' : 'schede'} in questa finestra`}
                >
                  {isCollapsed ? (
                    <ChevronRight size={12} className="flex-shrink-0 text-app-text-tertiary" />
                  ) : (
                    <ChevronDown size={12} className="flex-shrink-0 text-app-text-tertiary" />
                  )}
                  <Icon size={13} className="flex-shrink-0 text-app-text-tertiary" />
                  <span className="min-w-0 flex-1 truncate">{row.label}</span>
                  <span className="flex-shrink-0 pr-1 text-[11px] tabular-nums text-app-text-tertiary">
                    {row.tabs.length}
                  </span>
                </button>
                {row.onActivate && (
                  <button
                    onClick={row.onActivate}
                    className="flex-shrink-0 rounded px-1.5 py-1 text-[11px] text-app-text-tertiary opacity-0 transition-opacity hover:bg-app-hover hover:text-app-text group-hover:opacity-100 focus:opacity-100"
                    title="Porta questa finestra in primo piano"
                    aria-label={`Vai alla finestra ${row.label}`}
                    data-testid="focus-window"
                  >
                    Vai
                  </button>
                )}
              </div>
              {!isCollapsed && (
                <div className="flex flex-col">
                  {row.tabs.map((tab) => {
                    const TabIcon = TAB_ICONS[tab.type] ?? LayoutGrid;
                    return (
                      <button
                        key={tab.id}
                        onClick={() => {
                          if (row.isSelf) onFocusTab(tab.id);
                          else row.onActivate?.();
                        }}
                        className="flex w-full items-center gap-2 rounded-md py-1 pl-6 pr-2 text-left text-[12px] text-app-text-secondary transition-colors hover:bg-app-hover hover:text-app-text"
                        data-testid="window-tab"
                        data-pane-type={tab.type}
                      >
                        <TabIcon size={12} className="flex-shrink-0 text-app-text-tertiary" />
                        <span className="min-w-0 flex-1 truncate">{tabLabel(tab, topics)}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 border-b border-app-border" />
    </div>
  );
}
