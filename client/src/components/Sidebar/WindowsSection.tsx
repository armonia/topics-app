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
// ONE RULE for every row: a window is described by the CHAT TOPICS it holds.
// That is exactly what the presence channel reports (usePanelLifecycle's
// `presenceTopicIds` strips project/terminal/browser/draft pane ids), so
// applying the same filter to our own row keeps every row comparable instead of
// making "this window" the only one that also lists panes.
//
// Zero chrome when there is nothing to disambiguate: with a single window the
// section renders nothing (the tree below already lists those topics).
import { useState } from 'react';
import { AppWindow, ChevronDown, ChevronRight, Monitor } from 'lucide-react';
import { focusOrReopenDetachedWindow, topicNamesLabel } from '@/lib/detachedWindow';
import { useOtherWindows } from '@/state/windowPresence';
import { useWorkspaceGroups } from '@/state/workspaceGroups';
import type { Topic } from '@/types';

interface WindowsSectionProps {
  topics: Record<string, Topic>;
  /** Focus a topic held by THIS window. */
  onTopicClick: (topicId: string) => void;
  /** Reopen a topic locally when another window can't be focused (dead / remote). */
  onReopenTopic: (topicId: string) => void;
}

export function WindowsSection({ topics, onTopicClick, onReopenTopic }: WindowsSectionProps) {
  const groups = useWorkspaceGroups();
  const others = useOtherWindows();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // Nothing else is open → nothing to place. Stay invisible rather than
  // duplicate the whole tree under a "this window" heading.
  if (others.length === 0) return null;

  // Every CHAT topic this window holds, across all its cells: the window is the
  // unit, so the split geometry is flattened away on purpose, and non-topic
  // panes are filtered exactly as the presence announce filters them.
  const localTopicIds = groups.flatMap((g) => g.paneIds).filter((id) => !!topics[id]);

  const rows = [
    {
      id: 'self',
      label: 'Questa finestra',
      topicIds: localTopicIds,
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
      topicIds: w.topicIds,
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
                  title={`${row.topicIds.length} chat in questa finestra`}
                >
                  {isCollapsed ? (
                    <ChevronRight size={12} className="flex-shrink-0 text-app-text-tertiary" />
                  ) : (
                    <ChevronDown size={12} className="flex-shrink-0 text-app-text-tertiary" />
                  )}
                  <Icon size={13} className="flex-shrink-0 text-app-text-tertiary" />
                  <span className="min-w-0 flex-1 truncate">{row.label}</span>
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
                  {row.topicIds.map((id) => (
                    <button
                      key={id}
                      onClick={() => {
                        if (row.isSelf) onTopicClick(id);
                        else row.onActivate?.();
                      }}
                      className="flex w-full items-center gap-2 rounded-md py-1 pl-7 pr-2 text-left text-[12px] text-app-text-secondary transition-colors hover:bg-app-hover hover:text-app-text"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {topics[id]?.name || topics[id]?.icon || id}
                      </span>
                    </button>
                  ))}
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
