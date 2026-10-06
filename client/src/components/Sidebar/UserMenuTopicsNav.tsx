/**
 * LE DUE RIGHE FRA I PIANI DEL FOGLIO UTENTE (mobile-chrome-feedback A1).
 *
 * Sul telefono il foglio ha due piani: la radice — chi sei (identita') e lo
 * stato (sistema, versione) — e il piano Topics, con le righe di
 * `TopicsMenuItems`. In mezzo ci sono queste due righe, e solo loro: la voce
 * «Topics» scende al piano, «Indietro» risale alla radice.
 *
 * PERCHE' DUE PIANI E NON LA LISTA PIATTA. Il foglio piatto mescolava dodici
 * righe di tre padroni diversi (identita', topics, sistema): il menu Topics
 * non aveva una porta, era un tratto di strada fra due tratti di altre strade.
 * Dietro una voce e' un posto che si raggiunge, e la radice resta il menu
 * utente — chi sei e come sta la macchina, a un tocco dall'apertura.
 *
 * E' un file a parte, e non due righe in App, perche' «Indietro» e' una parola
 * che si legge: App non importa `useT` (il secondo passaggio di
 * check-ui-language si accenderebbe su tutto il file) e queste due righe il
 * loro `tr` se lo prendono qui.
 */
import { ChevronLeft, ChevronRight, ListTree } from 'lucide-react';
import { useT } from '@/hooks/useT';
import { menuRowClass } from './menuRow';

/** La voce «Topics» nella radice del foglio: scende al piano dei topics. */
export function TopicsEntryRow({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="user-menu-topics-entry"
      className={menuRowClass(true)}
      // «Topics» e' un nome proprio, uguale nelle due lingue: le altre righe
      // del foglio lo scrivono gia' cosi' (l'intestazione della colonna).
      title="Topics"
      aria-label="Topics"
    >
      <ListTree size={18} className="flex-shrink-0" aria-hidden="true" />
      <span className="flex-1 text-left">Topics</span>
      <ChevronRight size={18} className="flex-shrink-0 text-app-text-tertiary" aria-hidden="true" />
    </button>
  );
}

/** La prima riga del piano Topics: risale alla radice del foglio. */
export function TopicsBackRow({ onBack }: { onBack: () => void }) {
  const tr = useT();
  return (
    <button
      type="button"
      onClick={onBack}
      data-testid="user-menu-topics-back"
      className={menuRowClass(true)}
      title={tr('sidebar.userMenuBack')}
      aria-label={tr('sidebar.userMenuBack')}
    >
      <ChevronLeft size={18} className="flex-shrink-0" aria-hidden="true" />
      <span className="flex-1 text-left">{tr('sidebar.userMenuBack')}</span>
    </button>
  );
}
