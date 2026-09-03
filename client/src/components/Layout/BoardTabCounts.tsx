/**
 * I CONTEGGI PER STATO SULLA TAB «BOARD».
 *
 * Una tab della board portava icona + nome e basta: chiusa dentro un gruppo di
 * split, o semplicemente non selezionata, non diceva NIENTE del lavoro che c'è
 * dietro — mentre la riga «Board» della sidebar lo dice da sempre. Questa è la
 * stessa cosa, ridotta alla misura di una tab: il glifo di stato della kanban
 * più il numero, per gli stati che cambiano una decisione.
 *
 * Le tre scelte, tutte prese altrove e qui solo RILETTE:
 *  · QUALI stati — `SUMMARY_STATUSES` in `lib/boardTabCounts`, condiviso con la
 *    sidebar: review (aspetta te) e in corso (agenti al lavoro). Gli zeri non
 *    si disegnano, quindi una board senza lavoro aperto lascia la tab com'era.
 *  · QUALE glifo — `StatusIcon`, lo stesso che la board disegna sulle card e in
 *    cima alle colonne, alla sua misura standard (14px): stessa forma, stesso
 *    significato, nessun secondo codice da imparare.
 *  · DA DOVE i numeri — `boardTasksStore`, cioè la STESSA lista che alimenta la
 *    sidebar. Nessuna seconda fetch: le tab bar sono una per gruppo di split,
 *    quindi «una fetch per lettore» qui non voleva dire due, voleva dire N.
 *
 * Non è un badge di attenzione: non pulsa, non si spegne quando guardi la tab,
 * non compete con `NotificationBadge`. È il contenuto della board, detto in due
 * numeri.
 */
import { useEffect, useMemo } from 'react';
import { StatusIcon } from '../Board/atoms';
import { STATUS_LABEL } from '../../lib/board';
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

export function BoardTabCounts({ projectPath }: { projectPath?: string }) {
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
  const counts = loaded ? live : cached;
  if (counts.length === 0) return null;
  return (
    <>
      {counts.map(({ status, n }) => (
        <span
          key={status}
          data-testid={`tab-board-count-${status}`}
          title={`${STATUS_LABEL[status]}: ${n}`}
          aria-label={`${STATUS_LABEL[status]}: ${n}`}
          className="flex items-center gap-0.5 tabular-nums text-[11px] leading-none text-app-text-secondary"
        >
          <StatusIcon status={status} />
          {n}
        </span>
      ))}
    </>
  );
}
