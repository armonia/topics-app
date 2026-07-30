import type { ReactNode } from 'react';

/**
 * Lo stato "non c'è niente da mostrare", in un posto solo.
 *
 * Prima ogni pannello scriveva il suo vuoto a mano, con stili che divergevano
 * anche DENTRO lo stesso file (CommandPalette rendeva "No projects" con
 * `px-4 py-8 text-center text-[13px]` e "Nessun risultato" di colonna con
 * `px-3 py-2 text-[11px] italic`). Le due misure NON sono un errore da
 * appiattire: sono due cose diverse, e restano due `variant`.
 *
 *  · `panel`   — il vuoto di TUTTO un pannello: centrato, generoso, con spazio
 *                per un'icona, un titolo, un suggerimento e un'azione.
 *  · `section` — il vuoto di UNA colonna dentro un layout a più colonne: una
 *                riga sola, discreta, in corsivo, senza rubare verticale alle
 *                colonne accanto.
 *
 * L'attesa ("sto caricando") è `Spinner`/`SpinnerFallback`; questo è il "vuoto".
 * La lingua dei testi la decide chi chiama — qui non si sceglie EN vs IT.
 */
export interface EmptyStateProps {
  /** L'illustrazione — tipicamente un'icona lucide già dimensionata. Solo `panel`. */
  icon?: ReactNode;
  /** La riga principale. In `section` è l'unico testo mostrato. */
  title: ReactNode;
  /** Il sotto-testo che spiega o suggerisce cosa fare. Solo `panel`. */
  hint?: ReactNode;
  /** Un'azione opzionale (un bottone). Solo `panel`. */
  action?: ReactNode;
  variant?: 'panel' | 'section';
  className?: string;
}

export function EmptyState({ icon, title, hint, action, variant = 'panel', className = '' }: EmptyStateProps) {
  if (variant === 'section') {
    // Vuoto di colonna: una riga sola, come la resa storica delle sezioni del
    // CommandPalette. Niente icona/azione — se servono, è un `panel`.
    return (
      <div data-testid="empty-state" data-variant="section" className={`px-3 py-2 text-[11px] text-app-text-muted italic ${className}`}>{title}</div>
    );
  }

  return (
    <div data-testid="empty-state" data-variant="panel" className={`flex flex-col items-center justify-center gap-1 px-4 py-8 text-center ${className}`}>
      {icon && <div className="text-app-text-muted opacity-40 mb-1">{icon}</div>}
      <p className="text-[13px] text-app-text-muted">{title}</p>
      {hint && <p className="text-[12px] text-app-text-tertiary max-w-xs">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
