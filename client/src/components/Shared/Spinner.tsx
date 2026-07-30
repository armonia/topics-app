/**
 * L'anello di caricamento dell'app, in un posto solo.
 *
 * Era lo stesso markup copiato 24 volte in 10 file — `w-N h-N border-…
 * border-app-spinner border-t-primary rounded-full animate-spin` — e copiato
 * male: la stessa misura girava con bordi diversi (`w-3` esisteva con `border`,
 * `border-[1.5px]` e `border-2`), cioè tre spessori per la stessa identica
 * attesa a seconda del file in cui capitavi. Qui le misure sono TRE e sono
 * queste; il resto lo decide chi chiama con `className` (margini, shrink).
 *
 * Perché un anello e non `Loader2` di lucide: convivono di proposito. L'anello
 * è l'attesa di un BLOCCO (un pannello che carica, un pane in Suspense), la
 * rotella lucide sta dentro le righe e i bottoni insieme alle altre icone.
 */
const RING = 'border-app-spinner border-t-primary rounded-full animate-spin';

const SIZES = {
  /** Dentro un bottone stretto, accanto a un'icona da 10px. */
  xs: 'w-2.5 h-2.5 border',
  /** Il default: righe di lista, header di sezione. */
  sm: 'w-3 h-3 border-2',
  /** Un pannello intero che sta caricando. */
  md: 'w-4 h-4 border-2',
} as const;

export type SpinnerSize = keyof typeof SIZES;

export function Spinner({ size = 'sm', className = '' }: { size?: SpinnerSize; className?: string }) {
  // Etichetta in inglese come il resto delle superfici di attesa («Loading...»
  // in App.tsx, JournalPanel, AgentAssignPanel, GitChanges): questo anello sta
  // accanto a quelle scritte in dieci file, e uno screen reader che legge
  // "Caricamento" sopra un "Loading..." visibile racconta due lingue nella
  // stessa schermata.
  return <div role="status" aria-label="Loading" className={`${SIZES[size]} ${RING} ${className}`} />;
}

/**
 * L'anello centrato nello spazio che ha — il fallback di `Suspense` per una
 * pane o un pannello lazy. `h-full` riempie il box del genitore; `fill` lo
 * mette invece in un flex che si prende lo spazio residuo, che è la forma di
 * cui hanno bisogno i pannelli dentro una colonna.
 */
export function SpinnerFallback({ fill = false }: { fill?: boolean }) {
  return (
    <div className={fill ? 'flex-1 flex items-center justify-center py-8' : 'flex items-center justify-center h-full'}>
      <Spinner size="md" />
    </div>
  );
}
