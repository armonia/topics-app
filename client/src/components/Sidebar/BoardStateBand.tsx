import { STATUS_LABEL, type BoardTask, type TaskStatus } from '../../lib/board';
import { openTaskInApp } from '../../lib/openTaskLink';
import { ROW_INSET, SIDEBAR_INDENT_STEP } from '../../lib/selectionStyles';

/**
 * Gli stati che la fascia mostra, nell'ordine in cui un task li attraversa.
 *
 * `done` è fuori di proposito: la Board generale conta il lavoro ATTIVO (è la
 * stessa regola per cui la sua riga compare solo con task non finiti), e una
 * lista di fatti — che cresce per sempre e non chiede niente a nessuno —
 * spingerebbe fuori dalla fascia proprio le quattro colonne per cui la si apre.
 */
const BOARD_BAND_STATUSES: readonly TaskStatus[] = ['review', 'in_progress', 'todo', 'backlog'];

/**
 * Il contenuto della fascia sotto la tessera «Board generale»: i task per
 * STATO, cioè la board letta come la si legge davvero — prima chi aspetta te
 * (review), poi chi sta lavorando, poi la coda.
 *
 * L'ordine non è quello del kanban da sinistra a destra: lì `backlog` viene
 * prima perché è una pipeline, qui viene ultimo perché è una lista di priorità.
 * Una fascia alta 4 righe che si apre su `backlog` non direbbe niente di
 * urgente.
 *
 * Le righe sono le stesse righe della sidebar (stessa altezza, stesso rientro
 * `ROW_INSET + depth * SIDEBAR_INDENT_STEP`, stesso hover): la fascia è dentro
 * la sidebar, non è un pannello ospite.
 */
export function BoardStateBand({
  byStatus,
  depth = 1,
}: {
  byStatus: Record<TaskStatus, BoardTask[]> | undefined;
  /** Livello di annidamento, come per ogni riga dell'albero. */
  depth?: number;
}) {
  const groups = BOARD_BAND_STATUSES
    .map(status => ({ status, tasks: byStatus?.[status] ?? [] }))
    .filter(g => g.tasks.length > 0);

  const inset = ROW_INSET + depth * SIDEBAR_INDENT_STEP;

  if (groups.length === 0) {
    return (
      <div className="py-1 text-[11px] text-app-text-muted" style={{ paddingLeft: inset }}>
        Nessun task attivo
      </div>
    );
  }

  return (
    <div className="py-1" data-testid="board-state-band">
      {groups.map(({ status, tasks }) => (
        <div key={status} data-testid={`board-state-group-${status}`}>
          <div
            className="flex items-center gap-1.5 h-6 text-[10px] font-semibold uppercase tracking-wide text-app-text-muted"
            style={{ paddingLeft: inset }}
          >
            <span>{STATUS_LABEL[status]}</span>
            <span className="text-app-text-muted/70">{tasks.length}</span>
          </div>
          {tasks.map(task => (
            <button
              key={task.id}
              type="button"
              role="treeitem"
              data-testid="board-state-task"
              data-task-id={task.id}
              title={task.text}
              // Apre il drawer del task sulla board, non solo la board: da qui
              // si guarda UN task: portare alla board e lasciarti ricercare la
              // riga che avevi appena in mano sarebbe un passo indietro.
              onClick={() => openTaskInApp({ taskId: task.id })}
              className="flex items-center gap-1.5 w-full h-7 pr-2 rounded-md select-none text-app-text hover:bg-app-hover transition-colors"
              style={{ paddingLeft: inset + SIDEBAR_INDENT_STEP }}
            >
              <span className="text-[12px] flex-1 text-left truncate">{task.text}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
