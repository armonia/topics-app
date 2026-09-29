/**
 * HOW MUCH WORK SITS BEHIND A BOARD TAB, by status.
 *
 * A board tab used to say nothing about the work behind it while the sidebar
 * "Board" row always did. The statuses are `SUMMARY_STATUSES`
 * (`lib/boardTabCounts`, shared with the sidebar): review, which waits for you,
 * and in progress, where agents are working. The numbers come from
 * `boardTasksStore`, the same list the sidebar reads: tab bars are one per
 * split group, so a fetch per reader would mean N fetches.
 *
 * They are no longer drawn as a row of glyphs and numbers in the tab: that row
 * took the label's width (TABSLOT-01). The tab's one slot carries them instead,
 * review as the number and in progress as the ring (TABSLOT-02); the exact
 * counts are in its tooltip.
 */
import { useEffect, useMemo } from 'react';
import { boardTabCounts, type StatusCount } from '../../lib/boardTabCounts';
import { useBoardTasks, useBoardTasksLoaded } from '../../lib/boardTasksStore';
import { useBoardProjects } from '../../lib/boardProjectsStore';

/** Un percorso confrontabile: la stessa cartella non deve diventare due
 *  progetti diversi per via di uno slash finale. */
const norm = (p: string): string => p.replace(/\/+$/, '');

/**
 * The counts this device last drew for a tab, kept until the 1.5 MB task feed
 * has landed. The feed arrives 1-1.3 s after the first paint, and a trail that
 * grows by 23 px at that moment moves the tab label under it — measured on a
 * reload, 2026-09-03. What is cached is the RESULT (a handful of numbers per
 * tab), never the feed; the live rows replace it as soon as they exist.
 */
const COUNTS_CACHE_PREFIX = 'topics-board-tab-counts:';
function readCachedCounts(key: string): StatusCount[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? (parsed as StatusCount[]) : [];
  } catch {
    return [];
  }
}
function rememberCounts(key: string, counts: StatusCount[]): void {
  try {
    if (counts.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(counts));
  } catch { /* storage denied: the trail simply arrives with the feed */ }
}

/**
 * The counts behind a board tab, for its slot (TABSLOT-02): the cards in
 * review are the number that asks for you, the cards in progress are the ring.
 */
export function useBoardTabCounts(projectPath?: string): StatusCount[] {
  const tasks = useBoardTasks();
  // L'indice serve SOLO alla tab di progetto (per tradurre il percorso in
  // board id): sulla board generale non si sottoscrive nemmeno.
  const index = useBoardProjects(!!projectPath);
  const projectId = useMemo(
    () => (projectPath ? index?.find((p) => p.path && norm(p.path) === norm(projectPath))?.projectId ?? null : null),
    [index, projectPath],
  );
  const live = useMemo(
    // Finché il percorso non è risolto in un board id NON si conta: mostrare
    // intanto il totale di TUTTI i progetti sarebbe un numero sbagliato che si
    // corregge da solo dopo un giro — e nel frattempo è indistinguibile da uno
    // giusto. Meglio niente per un istante che una cifra che mente.
    () => (projectPath && !projectId ? [] : boardTabCounts(tasks, projectId)),
    [tasks, projectId, projectPath],
  );
  // Live only once BOTH inputs exist: the feed, and — for a project tab — its
  // board id. Before that the live value is an empty list that means «not yet»,
  // not «zero», and remembering it would erase a real count.
  const loaded = useBoardTasksLoaded() && (!projectPath || projectId !== null);
  const cacheKey = COUNTS_CACHE_PREFIX + (projectPath ? norm(projectPath) : 'all');
  const cached = useMemo(() => readCachedCounts(cacheKey), [cacheKey]);
  useEffect(() => { if (loaded) rememberCounts(cacheKey, live); }, [loaded, live, cacheKey]);
  return loaded ? live : cached;
}
