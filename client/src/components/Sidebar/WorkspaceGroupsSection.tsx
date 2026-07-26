// WorkspaceGroupsSection — sidebar view of the GROUPS in this window, with a
// one-click "Stacca" (detach) on each.
//
// WHY: a group (a cell of tabs) is the unit you detach into its own OS window,
// but until now it existed only inside the grid — the only way to detach one was
// a right-click buried in the tab bar, and the sidebar showed no trace of it. So
// the sidebar showed the RESULT of detaching ("Finestre aperte", the section
// right above this one) but never the SOURCE. This closes that loop: every group
// still in this window is listed, expandable to its tabs, and detachable here.
//
// Rendered only when the workspace is actually split (2+ groups) — with a single
// pool there is no "group" concept to surface, just the flat tab list the tree
// below already shows.
import { useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, Layers } from 'lucide-react';
import { capNamesLabel } from '@/lib/detachedWindow';
import { getProjectPathFromPaneId } from '@/state/pane/adapters';
import { usePaneStore } from '@/state/pane/store';
import { useWorkspaceGroups } from '@/state/workspaceGroups';
import type { Pane } from '@/state/pane/types';
import type { Topic } from '@/types';

/** Readable name for ANY member of a group — a chat topic, or a project /
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

interface WorkspaceGroupsSectionProps {
  topics: Record<string, Topic>;
  /** Focus a topic in the grid (click on a member row). */
  onTopicClick: (topicId: string) => void;
  /** Pop the whole group out into its own window. */
  onDetachGroup: (topicIds: string[]) => void;
}

export function WorkspaceGroupsSection({ topics, onTopicClick, onDetachGroup }: WorkspaceGroupsSectionProps) {
  const groups = useWorkspaceGroups();
  const panes = usePaneStore((s) => s.panes);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // Mirror EVERY cell — a group holding a project/terminal/browser pane is just
  // as real as a chat one, and hiding it would make the section lie about the
  // layout. Only the DETACH affordance narrows: `window_detach` takes topic ids,
  // so it appears for the chat topics a group actually has.
  const rows = groups
    .filter((g) => g.paneIds.length > 0)
    .map((g) => ({
      key: g.key,
      paneIds: g.paneIds,
      detachableIds: g.paneIds.filter((id) => !!topics[id]),
    }));

  if (rows.length < 2) return null;

  return (
    <div className="px-2 pt-2 pb-1" data-testid="sidebar-workspace-groups">
      <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wider text-app-text-tertiary">
        Gruppi in questa finestra
      </div>
      <div className="flex flex-col gap-0.5">
        {rows.map((g) => {
          const isCollapsed = collapsed[g.key] ?? false;
          const label = capNamesLabel(g.paneIds.map((id) => paneDisplayName(id, topics, panes))) || 'Gruppo';
          return (
            <div key={g.key}>
              <div className="group flex w-full items-center gap-1 rounded-md pl-1 pr-1 text-[13px] text-app-text transition-colors hover:bg-app-hover">
                <button
                  onClick={() => setCollapsed((c) => ({ ...c, [g.key]: !isCollapsed }))}
                  className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left"
                  aria-expanded={!isCollapsed}
                  title={`${g.paneIds.length} schede in questo gruppo`}
                >
                  {isCollapsed ? (
                    <ChevronRight size={12} className="flex-shrink-0 text-app-text-tertiary" />
                  ) : (
                    <ChevronDown size={12} className="flex-shrink-0 text-app-text-tertiary" />
                  )}
                  <Layers size={13} className="flex-shrink-0 text-app-text-tertiary" />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                </button>
                {g.detachableIds.length > 0 && (
                  <button
                    onClick={() => onDetachGroup(g.detachableIds)}
                    className="flex-shrink-0 rounded p-1 text-app-text-tertiary opacity-0 transition-opacity hover:bg-app-hover hover:text-app-text group-hover:opacity-100 focus:opacity-100"
                    title="Stacca il gruppo in una nuova finestra"
                    aria-label={`Stacca il gruppo ${label} in una nuova finestra`}
                    data-testid="detach-group"
                  >
                    <ExternalLink size={13} />
                  </button>
                )}
              </div>
              {!isCollapsed && (
                <div className="flex flex-col">
                  {g.paneIds.map((id) => (
                    <button
                      key={id}
                      onClick={() => { if (topics[id]) onTopicClick(id); }}
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
