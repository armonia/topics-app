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
 * TWO BRAKES, NOT ONE (KANBAN-75). "By count" is the one above and the default.
 * "By resources" asks a question the number cannot express, which is how much
 * of THIS computer Topics may take, and it answers with ONE percentage. The two
 * are an alternative, not two brakes stacked: in `resources` the fixed number
 * does not apply, so the number box and the three count states are NOT drawn,
 * rather than drawn and ignored.
 *
 * ONE KNOB, TWO AXES. The percentage is applied to the cores AND to the memory,
 * so there is nothing to keep in agreement: 80% of a 12-core, 32 GB machine is
 * 9.6 core-units and 25.6 GB. What used to be here (two thresholds against the
 * whole machine's load average) admitted the entire queue the moment the
 * average dipped, and never touched what was already running.
 *
 * THE COLOUR IS ON THE LIVE READING, not on the setting: how far from waiting
 * we are right now (`livePressureBand`, the same function the gauge uses). A
 * percentage of your own computer cannot be "wrong" the way a load threshold
 * could, so there is no band to paint on the track any more.
 *
 * ONE COMPONENT, EVERY SURFACE. The title menu and the settings panel mount
 * THIS, not two copies: state lives in `state/globalDispatchCap.ts` and every
 * write goes through `saveGlobalCap`. That is why a change made in one shows up
 * in the other without a reload, and why another window's `board:global-cap`
 * broadcast enters through a single door.
 */
import { useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import {
  GLOBAL_CAP_MAX, GLOBAL_CAP_MIN, GLOBAL_CAP_OFF,
  budgetShare, capMode, livePressureBand,
  BUDGET_SHARE_MIN, BUDGET_SHARE_MAX,
} from '../../lib/board';
import type { DispatchCapMode, ThresholdBand } from '../../lib/board';
import { DANGER_TEXT, SUCCESS_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { DispatchLoadSummary } from './DispatchLoadGauge';
import {
  currentCapLimit,
  saveGlobalCap,
  useGlobalDispatchCap,
} from '../../state/globalDispatchCap';

/** The text tone of each band. The three pairs are the ones measured AA on both
 *  themes in `popoverStyles`; a colour picked here by eye would fail one of them. */
const BAND_TEXT: Record<ThresholdBand, string> = {
  green: SUCCESS_TEXT,
  amber: WARNING_TEXT,
  red: DANGER_TEXT,
};

/** Deliberately propless: every surface mounts THE SAME thing, and a per-surface
 *  variant is the first step towards two controls that drift apart. */
export function GlobalCapControl() {
  const tr = useT();
  const s = useGlobalDispatchCap();
  const brake: DispatchCapMode = s.cap ? capMode(s.cap) : 'count';

  return (
    <div className="space-y-1" data-testid="global-cap-control">
      <p className="text-micro font-semibold uppercase tracking-wide text-app-text-muted">
        {tr('board.dispatch.parallel')}
      </p>

      {/* WHICH QUESTION the brake asks, before any answer to it. Two radios and
          not a checkbox "measure the machine instead": a checkbox has an implied
          default that reads as the normal case, and here neither is "normal" —
          they are two policies, and the second is opt-in on purpose. */}
      <div className="flex gap-0.5" role="radiogroup" aria-label={tr('board.dispatch.brake')} data-testid="global-cap-brake">
        {(['count', 'resources'] as const).map((m) => {
          const active = brake === m;
          return (
            <button
              key={m}
              role="radio"
              aria-checked={active}
              data-testid={`global-cap-brake-${m}`}
              disabled={s.saving || !s.cap}
              onClick={() => { if (!active) void saveGlobalCap({ mode: m }); }}
              className={`rounded px-1.5 py-0.5 text-mini ${active ? 'bg-emerald-500/80 text-white' : 'bg-white/5 text-app-text-secondary hover:bg-white/10'}`}
            >{tr(m === 'count' ? 'board.dispatch.brakeCount' : 'board.dispatch.brakeResources')}</button>
          );
        })}
      </div>

      {brake === 'count' ? <CountBrake /> : <ResourcesBrake />}

      {/* THE SAME READING AS THE COLUMN HEADER, under the knobs: while you turn
          one you see what you are limiting. Same store, same words, so the two
          surfaces cannot start disagreeing about the same machine. */}
      <DispatchLoadSummary />
    </div>
  );
}

/** The brake of always: how many together. `auto`, a fixed number, or none. */
function CountBrake() {
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
    <>
      {/* The live line comes before the controls: it is the one people come to
          read. Right under it, at a readable size and not as a footnote, the
          scope: that number is not "this board's". */}
      <p
        data-testid="global-cap-running"
        className={`text-compact font-medium ${full ? 'text-amber-300' : 'text-app-text-heading'}`}
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
      <p className="text-mini leading-snug text-app-text-secondary">{tr('board.dispatch.oneMachine')}</p>
      {full && (
        <p className="text-mini leading-snug text-amber-300/80">
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
              className={`rounded px-1.5 py-0.5 text-mini ${active ? 'bg-emerald-500/80 text-white' : 'bg-white/5 text-app-text-secondary hover:bg-white/10'}`}
            >{tr(label)}</button>
          );
        })}
      </div>

      {mode === 'auto' && s.capacity && (
        <p className="text-mini leading-snug text-app-text-faint">{s.capacity.reason}</p>
      )}
      {mode === 'off' && (
        <p className="text-mini leading-snug text-app-text-faint">{tr('board.dispatch.noLimitHint')}</p>
      )}
      {mode === 'fixed' && (
        <label className="flex items-center justify-between gap-3">
          <span className="text-mini text-app-text-muted">
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
    </>
  );
}

/**
 * The other brake: ONE percentage of this computer, the live reading against
 * it, and a verdict line that says what would happen to a new agent right now.
 * The fixed number is not drawn here because it does not apply.
 */
function ResourcesBrake() {
  const tr = useT();
  const s = useGlobalDispatchCap();
  const cap = s.capacity;
  const share = budgetShare(s.cap ?? {});
  const used = cap?.usedCoreUnits ?? null;
  const budget = cap?.budgetCoreUnits ?? 0;
  const usable = cap?.usableCoreUnits ?? 0;
  // "Would a new agent start" is answered from the SAME two numbers the gate
  // decides on: used against usable. The cost of the one to admit is the gate's
  // business (it has the measured history); here it is enough that the machine
  // is at its ceiling, which is what the person is looking at.
  const atCeiling = used != null && used >= usable;
  const running = cap?.running ?? 0;

  return (
    <>
      <p data-testid="global-cap-running" className="text-compact font-medium text-app-text-heading">
        {s.cap ? tr('board.dispatch.runningResources', { running }) : tr('board.dispatch.runningLoading')}
      </p>
      <p className="text-mini leading-snug text-app-text-secondary">{tr('board.dispatch.oneMachine')}</p>
      <p className="text-mini leading-snug text-app-text-faint">{tr('board.dispatch.resourcesHint')}</p>

      <BudgetSlider
        share={share}
        used={used}
        budget={budget}
        usable={usable}
        cores={cap?.cores ?? 0}
        totalMemGB={cap?.totalMemGB ?? 0}
        onCommit={(budgetShareNext) => { void saveGlobalCap({ budgetShare: budgetShareNext }); }}
      />

      {/* THE VERDICT, in words, and the exemption said out loud: a pass earned
          only because nobody is running yet is not a free machine, and the line
          must not claim it is. */}
      {cap && (
        <p
          data-testid="global-cap-verdict"
          data-admit={!atCeiling || running <= 0}
          className={`text-mini font-medium leading-snug ${
            !atCeiling ? SUCCESS_TEXT : running <= 0 ? WARNING_TEXT : DANGER_TEXT
          }`}
        >
          {!atCeiling
            ? tr('board.dispatch.verdictGo')
            : running <= 0
              ? tr('board.dispatch.verdictFirst')
              : tr('board.dispatch.verdictWait')}
        </p>
      )}
    </>
  );
}

/**
 * THE ONE KNOB: a percentage of this computer, what it means in the two units,
 * and the live reading coloured against it.
 *
 * WRITES ON RELEASE, NOT ON EVERY PIXEL. A drag fires an `input` event per
 * step; one PATCH each would be twenty writes and twenty broadcasts for one
 * gesture. While the pointer is down the value is a local draft; the write
 * happens on release. A change that arrives with no pointer down (arrow keys,
 * a test's `fill`) has no release to wait for and is written at once.
 */
function BudgetSlider({ share, used, budget, usable, cores, totalMemGB, onCommit }: {
  share: number;
  /** Core-units Topics is taking now, or `null` when not measured. */
  used: number | null;
  budget: number;
  usable: number;
  cores: number;
  totalMemGB: number;
  onCommit: (share: number) => void;
}) {
  const tr = useT();
  const [draft, setDraft] = useState<number | null>(null);
  const dragging = useRef(false);
  const shown = draft ?? share;
  const liveBand: ThresholdBand | null = used == null ? null : livePressureBand(used, usable || budget);
  const commit = (v: number) => {
    setDraft(null);
    if (v !== share) onCommit(v);
  };
  // What the percentage buys, in the units the gate decides in. It is drawn
  // from the DRAFT, so the two numbers move under the finger.
  const units = (cores * shown).toFixed(1);
  const mem = Math.round(totalMemGB * shown);
  const squeezed = usable > 0 && usable < budget - 0.05;

  return (
    <div className="space-y-0.5 pt-1" data-testid="global-cap-budget">
      <div className="flex items-center justify-between gap-2 text-mini">
        <span className="text-app-text-muted">{tr('board.dispatch.budget')}</span>
        <span className="font-medium text-app-text-heading" data-testid="global-cap-budget-value">
          {tr('board.dispatch.budgetOfPc', { pct: Math.round(shown * 100) })}
        </span>
      </div>
      <input
        type="range"
        data-testid="global-cap-budget-slider"
        aria-label={tr('board.dispatch.budget')}
        aria-valuetext={tr('board.dispatch.budgetOfPc', { pct: Math.round(shown * 100) })}
        min={BUDGET_SHARE_MIN}
        max={BUDGET_SHARE_MAX}
        step={0.05}
        value={shown}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-white/10"
        onPointerDown={() => { dragging.current = true; }}
        onPointerUp={() => { dragging.current = false; if (draft != null) commit(draft); }}
        onPointerCancel={() => { dragging.current = false; if (draft != null) commit(draft); }}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (dragging.current) setDraft(v);
          else commit(v);
        }}
      />
      {cores > 0 && (
        <p className="text-mini leading-snug text-app-text-faint" data-testid="global-cap-budget-units">
          {tr('board.dispatch.budgetHint', { cores, units, mem })}
        </p>
      )}
      <p
        className={`text-mini leading-snug ${liveBand ? BAND_TEXT[liveBand] : 'text-app-text-faint'}`}
        data-testid="global-cap-budget-live"
        data-band={liveBand ?? 'none'}
      >
        {used == null || cores <= 0
          ? tr('board.dispatch.liveLoading')
          : tr(squeezed ? 'board.dispatch.liveUseSqueezed' : 'board.dispatch.liveUse', {
              pct: Math.round((used / cores) * 100),
              used: used.toFixed(1),
              budget: budget.toFixed(1),
              usable: usable.toFixed(1),
            })}
      </p>
    </div>
  );
}
