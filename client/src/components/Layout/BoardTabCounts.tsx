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
import { useMemo } from 'react';
import { StatusIcon } from '../Board/atoms';
import { STATUS_LABEL } from '../../lib/board';
import { boardTabCounts } from '../../lib/boardTabCounts';
import { useBoardTasks } from '../../lib/boardTasksStore';
import { useBoardProjects } from '../../lib/boardProjectsStore';

/** Un percorso confrontabile: la stessa cartella non deve diventare due
 *  progetti diversi per via di uno slash finale. */
const norm = (p: string): string => p.replace(/\/+$/, '');

export function BoardTabCounts({ projectPath }: { projectPath?: string }) {
  const tasks = useBoardTasks();
  // L'indice serve SOLO alla tab di progetto (per tradurre il percorso in
  // board id): sulla board generale non si sottoscrive nemmeno.
  const index = useBoardProjects(!!projectPath);
  const projectId = useMemo(
    () => (projectPath ? index?.find((p) => p.path && norm(p.path) === norm(projectPath))?.projectId ?? null : null),
    [index, projectPath],
  );
  const counts = useMemo(
    // Finché il percorso non è risolto in un board id NON si conta: mostrare
    // intanto il totale di TUTTI i progetti sarebbe un numero sbagliato che si
    // corregge da solo dopo un giro — e nel frattempo è indistinguibile da uno
    // giusto. Meglio niente per un istante che una cifra che mente.
    () => (projectPath && !projectId ? [] : boardTabCounts(tasks, projectId)),
    [tasks, projectId, projectPath],
  );
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
