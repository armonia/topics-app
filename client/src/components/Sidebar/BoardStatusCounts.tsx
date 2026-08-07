import { useEffect, useMemo, useRef, useState } from 'react';
import { StatusIcon } from '../Board/atoms';
import { STATUS_LABEL, type BoardTask, type TaskStatus } from '../../lib/board';
import { useBoardProjects } from '../../lib/boardProjectsStore';
import { ProjectFavicon } from '../Shared/ProjectFavicon';
import { boardProjectChips, fitProjectChips } from './boardProjectChips';

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
 * ── Le icone sono QUELLE DELLA KANBAN ───────────────────────────────────────
 * Erano pallini pieni: stesso colore della colonna, ma una forma che la board
 * non usa da nessuna parte. Il colore da solo dice «rosso» — non dice «review»,
 * e nemmeno se una colonna viene prima o dopo un'altra. `StatusIcon` è il
 * glifo Linear-style che la board disegna sulle card e in cima alle colonne:
 * anello tratteggiato → anello vuoto → mezza torta → tre quarti → disco
 * spuntato. La stessa forma, quindi lo stesso significato, senza un secondo
 * codice da imparare (Attilio, 07/08: «utilizzare le icone coerenti con la
 * kanban per quanto riguarda lo stato»).
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
          <StatusIcon status={status} className="h-3 w-3" />
          {n}
        </span>
      ))}
    </span>
  );
}

/**
 * DI CHI SONO QUEI TASK — la seconda riga della board, sotto il nome.
 *
 * I numeri per colonna dicono a che punto è il lavoro; non dicono DOVE. Con
 * task su cinque progetti «3 in review» è un numero che non si può agire: prima
 * di aprire la board si vuole sapere se quei tre sono tutti sullo stesso
 * progetto o sparsi. Le pastiglie lo dicono con l'identità che il progetto ha
 * già — la sua icona — più il nome, che è ciò che resta a un progetto che
 * un'icona non ce l'ha (la stessa regola delle tessere fissate: mai un
 * monogramma, mai un glifo finto).
 *
 * ── Quante ne stanno ────────────────────────────────────────────────────────
 * Si MISURA (`fitProjectChips`), non si decide a priori: la sidebar cambia
 * larghezza col trascinamento del bordo, e sotto i 768px è larga tutto lo
 * schermo. Il ritaglio è dichiarato — «+2» — invece di lasciar sparire in
 * silenzio dei progetti dietro un `overflow: hidden`.
 */
export function BoardProjectChips({ byStatus }: { byStatus: Record<TaskStatus, BoardTask[]> | undefined }) {
  const index = useBoardProjects();
  const chips = useMemo(() => boardProjectChips(byStatus, index), [byStatus, index]);

  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // La larghezza si legge dall'osservatore e basta: una lettura sincrona qui
    // dentro sarebbe una scrittura di stato in montaggio, e l'osservatore
    // consegna comunque la prima misura appena il layout è pronto.
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width ?? 0;
      setWidth(prev => (Math.abs(prev - w) < 1 ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { shown, hidden } = fitProjectChips(width, chips);

  // Il contenitore si rende SEMPRE (anche a zero pastiglie): è lui che va
  // misurato, e un elemento che nasce solo quando c'è qualcosa da mostrare non
  // può dire quanto spazio ha.
  return (
    <div
      ref={ref}
      data-testid="board-project-chips"
      className="flex min-w-0 items-center gap-1.5 overflow-hidden"
    >
      {shown.map(chip => (
        <span
          key={chip.projectId}
          data-testid={`board-project-${chip.projectId}`}
          title={`${chip.name}: ${chip.n} task aperti`}
          className="flex min-w-0 items-center gap-1 text-[10px] leading-none text-app-text-tertiary"
          style={{ width: 68, flexShrink: 0 }}
        >
          <ProjectFavicon path={chip.path} size={12} />
          <span className="min-w-0 flex-1 truncate">{chip.name}</span>
          <span className="tabular-nums">{chip.n}</span>
        </span>
      ))}
      {hidden > 0 && (
        <span
          data-testid="board-project-more"
          title={`Altri ${hidden} progetti con task aperti`}
          className="flex-shrink-0 text-[10px] leading-none tabular-nums text-app-text-tertiary"
        >
          +{hidden}
        </span>
      )}
    </div>
  );
}
