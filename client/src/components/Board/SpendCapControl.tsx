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
import { useState } from 'react';
import { useT } from '../../hooks/useT';
import { formatTokens } from '../../lib/formatTokens';
import { saveSpendCaps, useGlobalDispatchCap } from '../../state/globalDispatchCap';
import { capBoxValue, spendLabel } from './spendFormat';

/** What is being typed into a box right now. `undefined` = nothing is, so the
 *  box shows the cap the store holds. */
interface CapDraft { task?: string; day?: string }

export function SpendCapControl() {
  const tr = useT();
  const s = useGlobalDispatchCap();
  const spend = s.spend;
  // THE STORE IS THE VALUE, the draft is only what a finger is in the middle of.
  //
  // The boxes are typed into, so the typed text cannot go straight to the server:
  // that would be one write per keystroke and a value coming back rewritten
  // mid-word. The write happens when the field loses focus, or on Enter.
  //
  // What is NOT here any more is the mirror. The cap used to be copied into two
  // `useState`s by an effect that re-ran on every change of the authoritative
  // value, and a synchronous `setState` inside an effect paints the stale text
  // first and then renders again over it (`react-hooks/set-state-in-effect`
  // says exactly this). There is no second source to synchronise with: the
  // store already IS the value, so the box reads it directly and only falls
  // back to a local string while somebody is editing. The draft is dropped on
  // commit, which is the moment the store becomes right again.
  const [draft, setDraft] = useState<CapDraft>({});

  if (!spend) return null;

  const commit = (which: 'task' | 'day', raw: string) => {
    const dollars = raw.trim() === '' ? 0 : Number(raw);
    const cents = Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : 0;
    void saveSpendCaps(which === 'task' ? { perTaskCents: cents } : { perDayCents: cents });
    // `saveSpendCaps` publishes the new value optimistically and synchronously,
    // so letting the draft go here shows the committed cap, not the old one.
    setDraft((d) => ({ ...d, [which]: undefined }));
  };

  const capTask = spend.capTaskCents;
  const capDay = spend.capDayCents;
  const overDay = capDay > 0 && spend.cents24h >= capDay;
  const perTask = draft.task ?? capBoxValue(capTask);
  const perDay = draft.day ?? capBoxValue(capDay);

  return (
    <div className="space-y-1" data-testid="spend-cap-control">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">
        {tr('board.spend.title')}
      </p>

      {/* THE NUMBER, always. The total beside the window: 24 hours says whether
          last night went wrong, the total says what the whole thing has cost. */}
      <p className="text-[12px] font-medium text-app-text-heading" data-testid="spend-24h">
        {tr('board.spend.window', { amount: spendLabel(spend.cents24h) })}
        {spend.centsTotal > 0 && (
          <span className="font-normal text-app-text-secondary">
            {' · '}{tr('board.spend.total', { amount: spendLabel(spend.centsTotal) })}
          </span>
        )}
      </p>
      {spend.unpriced24h > 0 && (
        <p className="text-[11px] leading-snug text-app-text-secondary" data-testid="spend-unpriced">
          {tr('board.spend.unpriced', { tokens: formatTokens(spend.unpriced24h) })}
        </p>
      )}

      {/* THE CAPS. Empty = no limit, and the placeholder says so, not a tooltip. */}
      <div className="space-y-1 pt-0.5">
        <label className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-app-text-muted">{tr('board.spend.capTask')}</span>
          <input
            type="number"
            min={0}
            placeholder={tr('board.spend.capNone')}
            data-testid="spend-cap-task"
            value={perTask}
            disabled={s.saving}
            onChange={(e) => { const v = e.target.value; setDraft((d) => ({ ...d, task: v })); }}
            onBlur={(e) => commit('task', e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commit('task', (e.target as HTMLInputElement).value); }}
            className="w-20 shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-right text-app-text outline-none"
          />
        </label>
        <label className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-app-text-muted">{tr('board.spend.capDay')}</span>
          <input
            type="number"
            min={0}
            placeholder={tr('board.spend.capNone')}
            data-testid="spend-cap-day"
            value={perDay}
            disabled={s.saving}
            onChange={(e) => { const v = e.target.value; setDraft((d) => ({ ...d, day: v })); }}
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
            ? tr('board.spend.overDay', { spent: spendLabel(spend.cents24h), cap: spendLabel(capDay) })
            : tr('board.spend.leftDay', { amount: spendLabel(Math.max(0, capDay - spend.cents24h)) })}
        </p>
      )}
      {capTask > 0 && (
        <p className="text-[11px] leading-snug text-app-text-secondary" data-testid="spend-cap-task-note">
          {tr('board.spend.capTaskNote', { cap: spendLabel(capTask) })}
        </p>
      )}
      {capTask === 0 && capDay === 0 && (
        <p className="text-[11px] leading-snug text-app-text-faint" data-testid="spend-cap-off">
          {tr('board.spend.noCaps')}
        </p>
      )}
    </div>
  );
}
