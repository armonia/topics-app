import { STATUS_DOT } from '../Board/constants';
import { STATUS_LABEL, type BoardTask, type TaskStatus } from '../../lib/board';

/**
 * Gli stati riassunti sulla riga, nell'ordine in cui contano per chi guarda:
 * chi aspetta te, chi sta lavorando, poi la coda.
 *
 * Non è l'ordine del kanban da sinistra a destra — quello è una pipeline, e qui
 * la riga ha spazio per tre o quattro numeri: i primi devono essere quelli che
 * cambiano una decisione. `done` resta fuori, come per il conteggio della riga:
 * la board si annuncia per il lavoro APERTO.
 */
const SUMMARY_STATUSES: readonly TaskStatus[] = ['review', 'in_progress', 'todo', 'backlog'];

/**
 * Il conteggio per stato, sulla riga stessa.
 *
 * ── Perché non una fascia che si apre ───────────────────────────────────────
 * Un accordion chiede un gesto per dire una cosa che sta in quattro numeri, e
 * quella cosa — «quanti ne ho in review, quanti stanno girando» — è esattamente
 * ciò che si vuole sapere SENZA aprire niente. La lista dei titoli, quando
 * serve, sta nella board: duplicarla nella sidebar significava tenerne due che
 * possono dire cose diverse.
 *
 * ── Perché pallini e non etichette ──────────────────────────────────────────
 * La riga è larga ~230px e il nome ne prende già una fetta. Il colore è quello
 * che la board usa già per la stessa colonna (`STATUS_DOT`, gemello di
 * `STATUS_ICON_COLOR`), quindi non è un codice nuovo da imparare: è lo stesso
 * azzurro che vedi sulla card in corso. Il nome per esteso resta nel `title`,
 * che è dove va ciò che serve solo a chi non è sicuro.
 */
export function BoardStatusCounts({ byStatus }: { byStatus: Record<TaskStatus, BoardTask[]> | undefined }) {
  const counts = SUMMARY_STATUSES
    .map(status => ({ status, n: byStatus?.[status]?.length ?? 0 }))
    .filter(c => c.n > 0);

  if (counts.length === 0) return null;

  return (
    <span className="flex items-center gap-1.5 flex-shrink-0" data-testid="board-status-counts">
      {counts.map(({ status, n }) => (
        <span
          key={status}
          data-testid={`board-count-${status}`}
          title={`${STATUS_LABEL[status]}: ${n}`}
          className="flex items-center gap-1 text-[10px] leading-none tabular-nums text-app-text-secondary"
        >
          <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[status]}`} aria-hidden="true" />
          {n}
        </span>
      ))}
    </span>
  );
}
