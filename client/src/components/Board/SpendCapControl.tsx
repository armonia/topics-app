/**
 * WHAT THE AGENTS HAVE SPENT, and the two caps that are born OFF.
 *
 * TWO THINGS IN ONE PANEL, and the order is not decoration. First the SPEND in
 * dollars, which is always visible and depends on no setting: it is the number
 * that was missing (the board is about 38% of the bill and appeared in no dollar
 * counter). Then the caps, which stay empty until a person writes a figure.
 *
 * NO SUGGESTED VALUE. The two boxes are born empty and empty means unlimited: a
 * pre-filled cap is a cap nobody chose, and whoever accepts it out of inertia
 * discovers it only when it stops a card. For the same reason there is no alarm
 * pill here when there is no cap: you cannot be close to a limit that does not
 * exist.
 *
 * THE UNPRICED SHARE sits next to the number and not in a tooltip. A model with
 * no price list produces consumption nobody can translate into dollars: if that
 * slice stayed invisible, the total (and the cap resting on it) would make
 * itself look complete while it is not.
 *
 * Like `GlobalCapControl`: propless, one single writer (`saveSpendCaps`), one
 * shared module store. Two copies of the same number on two surfaces are how one
 * window shows a cap the other has already changed.
 */
import { useEffect, useState } from 'react';
import { formatTokens } from '../../lib/formatTokens';
import { saveSpendCaps, useGlobalDispatchCap } from '../../state/globalDispatchCap';

/** Cents to dollars, the way it is written to a person. */
function usd(cents: number): string {
  const v = cents / 100;
  return v >= 100 ? `$${Math.round(v).toLocaleString('it-IT')}` : `$${v.toFixed(2)}`;
}

/** The box value: empty when there is no cap (zero is not a cap). */
function boxValue(cents: number): string {
  return cents > 0 ? String(Math.round(cents / 100)) : '';
}

export function SpendCapControl() {
  const s = useGlobalDispatchCap();
  const spend = s.spend;
  // The boxes are typed into: without a local state, every keystroke would be a
  // write to the server and a value coming back rewritten mid-word. The write
  // happens when the field loses focus, or on Enter.
  const [perTask, setPerTask] = useState<string>('');
  const [perDay, setPerDay] = useState<string>('');
  useEffect(() => {
    if (!spend) return;
    setPerTask(boxValue(spend.capTaskCents));
    setPerDay(boxValue(spend.capDayCents));
  }, [spend?.capTaskCents, spend?.capDayCents]);

  if (!spend) return null;

  const commit = (which: 'task' | 'day', raw: string) => {
    const dollars = raw.trim() === '' ? 0 : Number(raw);
    const cents = Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : 0;
    void saveSpendCaps(which === 'task' ? { perTaskCents: cents } : { perDayCents: cents });
  };

  const capTask = spend.capTaskCents;
  const capDay = spend.capDayCents;
  const overDay = capDay > 0 && spend.cents24h >= capDay;

  return (
    <div className="space-y-1" data-testid="spend-cap-control">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">
        Spesa degli agenti
      </p>

      {/* THE NUMBER, always. The total beside the window: 24 hours says whether
          last night went wrong, the total says what the whole thing has cost. */}
      <p className="text-[12px] font-medium text-app-text-heading" data-testid="spend-24h">
        {usd(spend.cents24h)} nelle ultime 24h
        {spend.centsTotal > 0 && (
          <span className="font-normal text-app-text-secondary"> · {usd(spend.centsTotal)} in tutto</span>
        )}
      </p>
      {spend.unpriced24h > 0 && (
        <p className="text-[11px] leading-snug text-app-text-secondary" data-testid="spend-unpriced">
          {formatTokens(spend.unpriced24h)} token non prezzabili (modello senza listino): non sono in questa cifra.
        </p>
      )}

      {/* THE CAPS. Empty = no limit, and the placeholder says so, not a tooltip. */}
      <div className="space-y-1 pt-0.5">
        <label className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-app-text-muted">Tetto per card (USD)</span>
          <input
            type="number"
            min={0}
            placeholder="nessuno"
            data-testid="spend-cap-task"
            value={perTask}
            disabled={s.saving}
            onChange={(e) => setPerTask(e.target.value)}
            onBlur={(e) => commit('task', e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commit('task', (e.target as HTMLInputElement).value); }}
            className="w-20 shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-right text-app-text outline-none"
          />
        </label>
        <label className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-app-text-muted">Tetto per macchina, 24h (USD)</span>
          <input
            type="number"
            min={0}
            placeholder="nessuno"
            data-testid="spend-cap-day"
            value={perDay}
            disabled={s.saving}
            onChange={(e) => setPerDay(e.target.value)}
            onBlur={(e) => commit('day', e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commit('day', (e.target as HTMLInputElement).value); }}
            className="w-20 shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-right text-app-text outline-none"
          />
        </label>
      </div>

      {/* THE DISTANCE from the cap, and ONLY if there is a cap. Without one this
          line does not exist: there is no distance from a limit nobody chose, and
          printing one would be inventing an alarm. */}
      {capDay > 0 && (
        <p
          data-testid="spend-cap-distance"
          className={`text-[11px] leading-snug ${overDay ? 'text-amber-300' : 'text-app-text-secondary'}`}
        >
          {overDay
            ? `Tetto giornaliero superato (${usd(spend.cents24h)} su ${usd(capDay)}): il turno successivo non parte.`
            : `Restano ${usd(Math.max(0, capDay - spend.cents24h))} prima del tetto giornaliero.`}
        </p>
      )}
      {capTask > 0 && (
        <p className="text-[11px] leading-snug text-app-text-secondary" data-testid="spend-cap-task-note">
          Una card che arriva a {usd(capTask)} non fa partire il turno successivo, e lo scrive nel suo thread.
        </p>
      )}
      {capTask === 0 && capDay === 0 && (
        <p className="text-[11px] leading-snug text-app-text-faint" data-testid="spend-cap-off">
          Nessun tetto: nessun freno, nessun avviso. Il numero sopra si vede comunque.
        </p>
      )}
    </div>
  );
}
