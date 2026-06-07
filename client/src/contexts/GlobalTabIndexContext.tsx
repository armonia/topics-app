/**
 * GlobalTabIndexContext — provides a paneId → global tab index map so
 * PaneTabBar can render correct ⌘N badges that match the global Cmd+1-9
 * mapping owned by `useKeyboardShortcuts`.
 *
 * The map covers BOTH top-level panel ids (chat panels, terminal panels…)
 * and inner project pane ids. Top-level project panels themselves DO NOT
 * get an entry — they're never directly Cmd-N-targetable; only their inner
 * panes are. Consumers that don't find an entry should hide the badge.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { isProjectPaneId, getProjectPathFromPaneId } from '../state/pane/adapters';

type GlobalTabIndexMap = Record<string, number>;

const GlobalTabIndexContext = createContext<GlobalTabIndexMap>({});

interface ProviderProps {
  openPanels: string[];
  projectOpenPanes: Record<string, string[]>;
  children: ReactNode;
}

export function GlobalTabIndexProvider({ openPanels, projectOpenPanes, children }: ProviderProps) {
  const value = useMemo<GlobalTabIndexMap>(() => {
    const map: GlobalTabIndexMap = {};
    let idx = 0;
    for (const panelId of openPanels) {
      if (isProjectPaneId(panelId)) {
        const projectPath = getProjectPathFromPaneId(panelId);
        const innerPanes = projectPath ? projectOpenPanes[projectPath] : undefined;
        if (innerPanes && innerPanes.length > 0) {
          for (const innerPaneId of innerPanes) {
            map[innerPaneId] = idx++;
          }
        } else {
          // Empty project — give the project pane itself the slot so Cmd+N
          // at least focuses it (matches buildGlobalTabList's fallback).
          map[panelId] = idx++;
        }
      } else {
        map[panelId] = idx++;
      }
    }
    return map;
  }, [openPanels, projectOpenPanes]);

  return (
    <GlobalTabIndexContext.Provider value={value}>
      {children}
    </GlobalTabIndexContext.Provider>
  );
}

/** Returns the 0-based global tab index for a pane, or -1 if unmapped. */
// eslint-disable-next-line react-refresh/only-export-components -- idiomatic Provider+hook colocation; the consumer hook belongs with its context
export function useGlobalTabIndex(paneId: string): number {
  const map = useContext(GlobalTabIndexContext);
  return map[paneId] ?? -1;
}
