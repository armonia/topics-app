/**
 * The folded projects, ONE set for the Kanban lanes and the Plan tiles: a
 * project folded in one view is folded in the other, because they are two
 * readings of the same board and must not disagree on what is hidden.
 * Kept per viewer in localStorage (`boardGeometry.ts`).
 */
import { useCallback, useSyncExternalStore } from 'react';
import { readCollapsedProjects, writeCollapsedProjects } from './boardGeometry';
import { toggleCollapsed } from './boardLanes';

let current: Set<string> | null = null;
const listeners = new Set<() => void>();

function snapshot(): Set<string> {
  if (!current) current = readCollapsedProjects();
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useCollapsedProjects(): { collapsed: ReadonlySet<string>; toggle: (projectId: string) => void } {
  const collapsed = useSyncExternalStore(subscribe, snapshot, snapshot);
  const toggle = useCallback((projectId: string) => {
    current = toggleCollapsed(snapshot(), projectId);
    writeCollapsedProjects(current);
    for (const listener of listeners) listener();
  }, []);
  return { collapsed, toggle };
}
