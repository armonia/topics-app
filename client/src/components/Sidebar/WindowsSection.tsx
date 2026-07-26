// WindowsSection — "what's open in which WINDOW", the sidebar's view of the
// detach model.
//
// A group here is a WINDOW, not a split cell: the unit that gets popped out
// ("Stacca il gruppo in una nuova finestra") and lives on as its own OS window.
// The intra-window split layout is deliberately NOT represented — a pane split
// in two is still one window, and showing cells here made the sidebar describe
// geometry instead of the thing the user reasons about.
//
// Rows: this window first (its topics, from the live local layout), then every
// OTHER window from the WS presence channel. Click a foreign window → focus it
// natively; if it's gone / on another machine, fall back to reopening its
// topics here.
//
// Zero chrome when there is nothing to disambiguate: with a single window the
// section renders nothing (the tree below already lists those topics).
import { useState } from 'react';
import { AppWindow, ChevronDown, ChevronRight, Monitor } from 'lucide-react';
import { capNamesLabel, focusOrReopenDetachedWindow } from '@/lib/detachedWindow';
import { getProjectPathFromPaneId } from '@/state/pane/adapters';
import { usePaneStore } from '@/state/pane/store';
import { useDetachedWindows } from '@/state/windowPresence';
import { useWorkspaceGroups } from '@/state/workspaceGroups';
import type { Pane } from '@/state/pane/types';
import type { Topic } from '@/types';

/** Readable name for any pane a window holds — a chat topic, or a project /
 *  terminal / browser / utility pane (which have no Topic record). */
function paneDisplayName(
  id: string,
  topics: Record<string, Topic>,
  panes: Record<string, Pane>,
): string {
  const t = topics[id];
  if (t) return t.name || t.icon || id;
  const title = panes[id]?.title;
  if (title) return title;
  const projectPath = getProjectPathFromPaneId(id);
  if (projectPath) return projectPath.split('/').filter(Boolean).pop() || 'Progetto';
  if (id.startsWith('terminal:')) return 'Terminale';
  if (id.startsWith('browser:')) return 'Browser';
  if (id.startsWith('utility:')) return 'Strumento';
  return id;
}

interface WindowsSectionProps {
  topics: Record<string, Topic>;
  /** Focus a topic held by THIS window. */
  onTopicClick: (topicId: string) => void;
  /** Reopen a topic locally when another window can't be focused (dead / remote). */
  onReopenTopic: (topicId: string) => void;
}

export function WindowsSection({ topics, onTopicClick, onReopenTopic }: WindowsSectionProps) {
  const groups = useWorkspaceGroups();
  const detached = useDetachedWindows();
  const panes = usePaneStore((s) => s.panes);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // With no other window there is nothing to place — stay invisible rather than
  // duplicate the whole tree under a "this window" heading.
  if (detached.length === 0) return null;

  // Every pane this window holds, across all its cells: the window IS the unit,
  // so the split geometry is flattened away on purpose.
  const localIds = groups.flatMap((g) => g.paneIds);

  const rows = [
    {
      id: 'self',
      label: 'Questa finestra',
      paneIds: localIds,
      isSelf: true,
      onActivate: undefined as (() => void) | undefined,
    },
    ...detached.map((w) => ({
      id: w.windowId,
      label: capNamesLabel(w.topicIds.map((id) => paneDisplayName(id, topics, panes))) || 'Finestra',
      paneIds: w.topicIds,
      isSelf: false,
      onActivate: () => focusOrReopenDetachedWindow(w, onReopenTopic),
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
                  title={`${row.paneIds.length} schede in questa finestra`}
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
                  {row.paneIds.map((id) => (
                    <button
                      key={id}
                      onClick={() => {
                        if (row.isSelf) {
                          if (topics[id]) onTopicClick(id);
                        } else {
                          row.onActivate?.();
                        }
                      }}
                      className="flex w-full items-center gap-2 rounded-md py-1 pl-7 pr-2 text-left text-[12px] text-app-text-secondary transition-colors hover:bg-app-hover hover:text-app-text"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {paneDisplayName(id, topics, panes)}
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
