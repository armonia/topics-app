/**
 * RelativeTime — «2m», «3h», «5d» che si AGGIORNANO.
 *
 * Prima ogni riga di sidebar formattava il proprio timestamp con un `Date.now()`
 * letto nel corpo del render. Un `Date.now()` in render non è una sottoscrizione:
 * il numero si congela al momento in cui la riga è stata disegnata e ci resta
 * finché qualcos'altro non la fa ri-renderizzare. Il risultato misurato è una
 * sidebar in cui una chat toccata mezz'ora fa continua a dire «2m» — l'unica
 * colonna che esiste per dire «quanto tempo fa» era quella che sbagliava.
 *
 * Qui il tempo arriva da `useSharedNow` (UN timer da 10s per tutta l'app, che si
 * spegne quando l'ultimo iscritto si smonta). La sottoscrizione sta in questa
 * FOGLIA e non nella riga: al tick si ri-renderizza uno `<span>`, non la card con
 * il suo albero di glifi, badge e menu.
 */
import { useSharedNow } from '@/state/useSharedNow';
import { formatRelative } from '@/state/workLongevity';

export function RelativeTime({
  at,
  className = '',
  title,
}: {
  /** epoch-ms, oppure una data ISO. Valori assenti/invalidi non rendono nulla. */
  at: number | string | undefined | null;
  className?: string;
  /** Tooltip. Di default la data assoluta, che è l'unica cosa che il relativo perde. */
  title?: string;
}) {
  const now = useSharedNow();
  const ms = typeof at === 'string' ? Date.parse(at) : at;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  return (
    <span className={className} title={title ?? new Date(ms).toLocaleString()}>
      {formatRelative(ms, now)}
    </span>
  );
}
