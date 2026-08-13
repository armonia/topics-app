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
import { GLOBAL_CAP_MAX, GLOBAL_CAP_MIN } from '../../lib/board';
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
  const full = limit !== null && running >= limit;
  const over = limit !== null && running > limit;

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
