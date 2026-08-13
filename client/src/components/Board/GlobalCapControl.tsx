/**
 * QUANTI AGENT POSSONO GIRARE INSIEME, detto per intero e in un posto solo.
 *
 * Prima questo controllo esisteva unicamente nel menu ▾ accanto al titolo della
 * board, e il pannello delle impostazioni lo nominava in un `title` (un tooltip:
 * su un telefono, niente). Il risultato, con le parole di chi usa la app: «ma io
 * non vedo i limiti».
 *
 * DUE COSE, NON UNA. Il tetto da solo non risponde alla domanda per cui lo si va
 * a cercare, che è «perché la coda non si muove». Serve accanto il numero di
 * agent al lavoro ADESSO: «3 di 8» si legge in un colpo d'occhio, e quando i due
 * numeri coincidono la riga lo dice a parole invece di lasciarlo dedurre.
 *
 * UN COMPONENTE PER DUE SUPERFICI. Il menu del titolo e il pannello montano
 * QUESTO, non due copie: lo stato sta in `state/globalDispatchCap.ts` e le
 * scritture passano tutte da `saveGlobalCap`. Ecco perché un cambio fatto in uno
 * dei due si vede nell'altro senza ricaricare, e perché il broadcast
 * `board:global-cap` di un'altra finestra entra da un punto solo.
 */
import { useT } from '../../hooks/useT';
import { GLOBAL_CAP_MAX, GLOBAL_CAP_MIN } from '../../lib/board';
import {
  currentCapLimit,
  saveGlobalCap,
  useGlobalDispatchCap,
} from '../../state/globalDispatchCap';

/** Senza parametri di proposito: le due superfici montano LA STESSA cosa, e una
 *  variante per superficie è il primo passo verso due controlli che divergono. */
export function GlobalCapControl() {
  const tr = useT();
  const s = useGlobalDispatchCap();
  const limit = currentCapLimit(s);
  const running = s.capacity?.running ?? 0;
  const full = limit !== null && running >= limit;

  return (
    <div className="space-y-1" data-testid="global-cap-control">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">
        {tr('board.dispatch.parallel')}
      </p>

      {/* La riga viva, prima dei comandi: è quella che si va a leggere. Subito
          sotto, a grandezza leggibile e non da nota a piè di pagina, la portata:
          quel numero non è «di questa board». */}
      <p
        data-testid="global-cap-running"
        className={`text-[12px] font-medium ${full ? 'text-amber-300' : 'text-app-text-heading'}`}
      >
        {limit === null
          ? tr('board.dispatch.runningLoading')
          : tr('board.dispatch.running', { running, cap: limit })}
      </p>
      <p className="text-[11px] leading-snug text-app-text-secondary">{tr('board.dispatch.oneMachine')}</p>
      {full && (
        <p className="text-[11px] leading-snug text-amber-300/80">{tr('board.dispatch.capFull')}</p>
      )}

      <label className="flex cursor-pointer items-center justify-between gap-3">
        <span>{tr('board.dispatch.parallelAuto')}</span>
        <input
          type="checkbox"
          data-testid="global-cap-auto"
          checked={!!s.cap?.auto}
          disabled={s.saving || !s.cap}
          onChange={(e) => { void saveGlobalCap({ auto: e.target.checked }); }}
          className="h-3.5 w-3.5 shrink-0 accent-emerald-500"
        />
      </label>

      {s.cap?.auto ? (
        s.capacity && (
          <p className="text-[11px] leading-snug text-app-text-faint">{s.capacity.reason}</p>
        )
      ) : (
        <label className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-app-text-muted">
            {tr('board.dispatch.fixed')}
            {s.capacity && (
              <span className="text-app-text-faint">
                {' '}({tr('board.dispatch.recommended', { n: s.capacity.recommended })})
              </span>
            )}
          </span>
          <input
            type="number"
            data-testid="global-cap-max"
            min={GLOBAL_CAP_MIN}
            max={GLOBAL_CAP_MAX}
            value={s.cap?.max ?? 3}
            onChange={(e) => { void saveGlobalCap({ max: Number(e.target.value) }); }}
            className="w-14 shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-right text-app-text outline-none"
          />
        </label>
      )}
    </div>
  );
}
