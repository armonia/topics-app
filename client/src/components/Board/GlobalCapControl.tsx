/**
 * HOW MANY AGENTS MAY RUN TOGETHER, spelled out, in one place.
 *
 * This control used to exist only in the ▾ menu next to the board title, and the
 * settings panel merely named it in a `title` attribute — a tooltip, which on a
 * phone is nothing at all. The result, in the words of the person using the app:
 * "but I can't see the limits".
 *
 * TWO NUMBERS, NOT ONE. The cap alone does not answer the question people open
 * it for, which is "why isn't the queue moving". It needs the count of agents
 * working RIGHT NOW beside it: "3 of 8" reads at a glance, and when the two
 * numbers meet the line says so in words instead of leaving it to be inferred.
 *
 * THE COUNT CAN EXCEED THE CAP, and the wording has to survive that. In `auto`
 * the denominator is the live machine recommendation, which moves with load
 * every 15s; lowering a fixed cap does the same thing instantly. Running turns
 * are never killed to fit, so "4 of 2" is a reachable state — and it reads as a
 * bug. Above the cap the line switches phrasing and says why it will settle.
 *
 * ONE COMPONENT, EVERY SURFACE. The title menu and the settings panel mount
 * THIS, not two copies: state lives in `state/globalDispatchCap.ts` and every
 * write goes through `saveGlobalCap`. That is why a change made in one shows up
 * in the other without a reload, and why another window's `board:global-cap`
 * broadcast enters through a single door.
 */
import { useT } from '../../hooks/useT';
import { GLOBAL_CAP_MAX, GLOBAL_CAP_MIN, GLOBAL_CAP_OFF } from '../../lib/board';
import {
  currentCapLimit,
  saveGlobalCap,
  useGlobalDispatchCap,
} from '../../state/globalDispatchCap';

/** Deliberately propless: every surface mounts THE SAME thing, and a per-surface
 *  variant is the first step towards two controls that drift apart. */
export function GlobalCapControl() {
  const tr = useT();
  const s = useGlobalDispatchCap();
  const limit = currentCapLimit(s);
  const running = s.capacity?.running ?? 0;
  // `Infinity` is the "no ceiling" answer, and nothing below is full or over
  // against it — a bare `running >= limit` would be false anyway, but saying so
  // once here keeps the three lines below from having to know about it.
  const bounded = limit !== null && Number.isFinite(limit);
  const full = bounded && running >= limit;
  const over = bounded && running > limit;
  const mode: 'auto' | 'fixed' | 'off' =
    !s.cap ? 'auto' : s.cap.auto ? 'auto' : s.cap.max === GLOBAL_CAP_OFF ? 'off' : 'fixed';
  /** The number the box shows and "Numero fisso" goes back to. Zero is the OFF
   *  sentinel, never a number to display, so it falls back to the default. */
  const lastFixed = s.cap && !s.cap.auto && s.cap.max > 0 ? s.cap.max : 3;

  return (
    <div className="space-y-1" data-testid="global-cap-control">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">
        {tr('board.dispatch.parallel')}
      </p>

      {/* The live line comes before the controls: it is the one people come to
          read. Right under it, at a readable size and not as a footnote, the
          scope: that number is not "this board's". */}
      <p
        data-testid="global-cap-running"
        className={`text-[12px] font-medium ${full ? 'text-amber-300' : 'text-app-text-heading'}`}
      >
        {limit === null
          ? tr('board.dispatch.runningLoading')
          : !bounded
            // "8 di Infinity" is what a bare interpolation would print here.
            ? tr('board.dispatch.runningNoLimit', { running })
            : over
              ? tr('board.dispatch.runningOver', { running, cap: limit })
              : tr('board.dispatch.running', { running, cap: limit })}
      </p>
      <p className="text-[11px] leading-snug text-app-text-secondary">{tr('board.dispatch.oneMachine')}</p>
      {full && (
        <p className="text-[11px] leading-snug text-amber-300/80">
          {tr(over ? 'board.dispatch.capOver' : 'board.dispatch.capFull')}
        </p>
      )}

      {/* THREE states that exclude one another, drawn as three. Two interacting
          checkboxes ("automatic" plus "no limit") would leave a fourth reading
          — both ticked — that means nothing, and someone would have to decide
          silently which one wins. */}
      <div className="flex gap-0.5" role="radiogroup" aria-label={tr('board.dispatch.parallel')}>
        {(['auto', 'fixed', 'off'] as const).map((m) => {
          const active = mode === m;
          const label = m === 'auto' ? 'board.dispatch.parallelAuto'
            : m === 'fixed' ? 'board.dispatch.fixed'
            : 'board.dispatch.noLimit';
          return (
            <button
              key={m}
              role="radio"
              aria-checked={active}
              data-testid={`global-cap-mode-${m}`}
              disabled={s.saving || !s.cap}
              onClick={() => {
                if (m === 'auto') { void saveGlobalCap({ auto: true }); return; }
                // Leaving `auto` needs BOTH halves in one write: the mode and the
                // number it means. Sending only `auto:false` would land on
                // whatever stale number the row still carried.
                void saveGlobalCap({ auto: false, max: m === 'off' ? GLOBAL_CAP_OFF : lastFixed });
              }}
              className={`rounded px-1.5 py-0.5 text-[11px] ${active ? 'bg-emerald-500/80 text-white' : 'bg-white/5 text-app-text-secondary hover:bg-white/10'}`}
            >{tr(label)}</button>
          );
        })}
      </div>

      {mode === 'auto' && s.capacity && (
        <p className="text-[11px] leading-snug text-app-text-faint">{s.capacity.reason}</p>
      )}
      {mode === 'off' && (
        <p className="text-[11px] leading-snug text-app-text-faint">{tr('board.dispatch.noLimitHint')}</p>
      )}
      {mode === 'fixed' && (
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
            value={lastFixed}
            onChange={(e) => { void saveGlobalCap({ max: Number(e.target.value) }); }}
            className="w-14 shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-right text-app-text outline-none"
          />
        </label>
      )}
    </div>
  );
}
