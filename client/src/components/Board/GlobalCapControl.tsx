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
 * "By resources" asks a question the number cannot express — how much of THIS
 * machine may the agents take — and answers it with two thresholds, load per
 * core and memory used over total. The two are an alternative, not two brakes
 * stacked: in `resources` the fixed number does not apply, so the number box
 * and the three count states are NOT drawn, rather than drawn and ignored.
 *
 * THE COLOURS ARE A JUDGEMENT ON THE THRESHOLD, not the machine's temperature.
 * A threshold can be wrong in two directions: too low and the queue never
 * starts, too high and the machine is unusable before the brake bites. The band
 * functions in `shared/board.ts` say which, and the slider paints THEM (sampled,
 * not copied): a number repeated here is a number that drifts. The live reading
 * is coloured against the chosen threshold instead (`livePressureBand`), which
 * is the third question: how far from waiting are we right now.
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
  capMode, capThresholds, machinePressureVerdict,
  loadThresholdBand, memThresholdBand, livePressureBand,
  LOAD_RATIO_MIN, LOAD_RATIO_MAX, LOAD_RATIO_DEFAULT,
  MEM_RATIO_MIN, MEM_RATIO_MAX, MEM_RATIO_DEFAULT,
} from '../../lib/board';
import type { DispatchCapacity, DispatchCapMode, ThresholdBand } from '../../lib/board';
import { DANGER_TEXT, SUCCESS_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { bandGradient } from './thresholdBand';
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
      <p className="text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">
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
              className={`rounded px-1.5 py-0.5 text-[11px] ${active ? 'bg-emerald-500/80 text-white' : 'bg-white/5 text-app-text-secondary hover:bg-white/10'}`}
            >{tr(m === 'count' ? 'board.dispatch.brakeCount' : 'board.dispatch.brakeResources')}</button>
          );
        })}
      </div>

      {brake === 'count' ? <CountBrake /> : <ResourcesBrake />}
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
    </>
  );
}

/** `used / total`, or `null` where the probe did not answer. Mirrors the
 *  formula inside `machinePressureVerdict` so the reading and the verdict
 *  cannot disagree about the same gigabytes. */
function memUsedRatio(cap: DispatchCapacity): number | null {
  if (cap.availableMemGB == null || !Number.isFinite(cap.availableMemGB) || !(cap.totalMemGB > 0)) return null;
  return Math.max(0, Math.min(1, 1 - cap.availableMemGB / cap.totalMemGB));
}

/**
 * The other brake: how much of the machine, as two thresholds against two live
 * readings, and one verdict line that says what would happen to a new agent
 * right now. The fixed number is not drawn here because it does not apply.
 */
function ResourcesBrake() {
  const tr = useT();
  const s = useGlobalDispatchCap();
  const cap = s.capacity;
  const running = cap?.running ?? 0;
  const thresholds = capThresholds(s.cap ?? {});
  const loadRatio = cap ? Math.max(0, cap.load1) / (cap.cores > 0 ? cap.cores : 1) : null;
  const memRatio = cap ? memUsedRatio(cap) : null;
  const verdict = cap
    ? machinePressureVerdict(
        { load1: cap.load1, cores: cap.cores, availableMemGB: cap.availableMemGB, totalMemGB: cap.totalMemGB, running },
        thresholds,
      )
    : null;

  return (
    <>
      <p data-testid="global-cap-running" className="text-[12px] font-medium text-app-text-heading">
        {s.cap ? tr('board.dispatch.runningResources', { running }) : tr('board.dispatch.runningLoading')}
      </p>
      <p className="text-[11px] leading-snug text-app-text-secondary">{tr('board.dispatch.oneMachine')}</p>
      <p className="text-[11px] leading-snug text-app-text-faint">{tr('board.dispatch.resourcesHint')}</p>

      <ThresholdSlider
        testId="global-cap-load"
        label={tr('board.dispatch.loadThreshold')}
        min={LOAD_RATIO_MIN}
        max={LOAD_RATIO_MAX}
        step={0.05}
        fallback={LOAD_RATIO_DEFAULT}
        value={thresholds.maxLoadRatio}
        band={loadThresholdBand}
        format={(v) => v.toFixed(2)}
        live={loadRatio}
        liveText={cap && loadRatio != null
          ? tr('board.dispatch.liveLoad', { load: cap.load1.toFixed(1), cores: cap.cores, ratio: loadRatio.toFixed(2) })
          : tr('board.dispatch.liveLoading')}
        onCommit={(maxLoadRatio) => { void saveGlobalCap({ maxLoadRatio }); }}
      />
      <ThresholdSlider
        testId="global-cap-mem"
        label={tr('board.dispatch.memThreshold')}
        min={MEM_RATIO_MIN}
        max={MEM_RATIO_MAX}
        step={0.01}
        fallback={MEM_RATIO_DEFAULT}
        value={thresholds.maxMemRatio}
        band={memThresholdBand}
        format={(v) => `${Math.round(v * 100)}%`}
        live={memRatio}
        liveText={!cap
          ? tr('board.dispatch.liveLoading')
          : memRatio == null
            // `null` is "not measured", and the verdict ignores it: say so,
            // instead of printing 0% and letting it read as an empty machine.
            ? tr('board.dispatch.liveMemUnknown')
            : tr('board.dispatch.liveMem', {
                used: (cap.totalMemGB - (cap.availableMemGB ?? 0)).toFixed(1),
                total: cap.totalMemGB.toFixed(0),
                pct: Math.round(memRatio * 100),
              })}
        onCommit={(maxMemRatio) => { void saveGlobalCap({ maxMemRatio }); }}
      />

      {/* THE VERDICT, in words, and the exemption said out loud: a pass earned
          only because nobody is running yet is not a free machine, and the line
          must not claim it is. */}
      {verdict && (
        <p
          data-testid="global-cap-verdict"
          data-admit={verdict.admit}
          className={`text-[11px] font-medium leading-snug ${
            !verdict.admit ? DANGER_TEXT : verdict.firstAgentExempt ? WARNING_TEXT : SUCCESS_TEXT
          }`}
        >
          {!verdict.admit
            ? tr('board.dispatch.verdictWait', {
                axis: tr(verdict.blockedBy === 'memory' ? 'board.dispatch.axisMem' : 'board.dispatch.axisLoad'),
              })
            : verdict.firstAgentExempt
              ? tr('board.dispatch.verdictFirst')
              : tr('board.dispatch.verdictGo')}
        </p>
      )}
    </>
  );
}

/**
 * One threshold: the slider, the band it sits in (painted and then said in
 * words), and the live reading coloured against it.
 *
 * WRITES ON RELEASE, NOT ON EVERY PIXEL. A drag fires an `input` event per
 * step; one PATCH each would be fifty writes and fifty broadcasts for one
 * gesture. While the pointer is down the value is a local draft; the write
 * happens on release. A change that arrives with no pointer down (arrow keys,
 * a test's `fill`) has no release to wait for and is written at once.
 */
function ThresholdSlider({ testId, label, min, max, step, fallback, value, band, format, live, liveText, onCommit }: {
  testId: string;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Where the band's "low side" ends and its "high side" begins: the default. */
  fallback: number;
  value: number;
  band: (ratio: number) => ThresholdBand;
  format: (v: number) => string;
  /** The machine right now, on the same scale, or `null` when not measured. */
  live: number | null;
  liveText: string;
  onCommit: (v: number) => void;
}) {
  const tr = useT();
  const [draft, setDraft] = useState<number | null>(null);
  const dragging = useRef(false);
  const shown = draft ?? value;
  const chosen = band(shown);
  const liveBand = live == null ? null : livePressureBand(live, shown);
  const commit = (v: number) => {
    setDraft(null);
    if (v !== value) onCommit(v);
  };
  const words = chosen === 'green'
    ? 'board.dispatch.band.green'
    : shown < fallback
      ? (chosen === 'amber' ? 'board.dispatch.band.amberLow' : 'board.dispatch.band.redLow')
      : (chosen === 'amber' ? 'board.dispatch.band.amberHigh' : 'board.dispatch.band.redHigh');

  return (
    <div className="space-y-0.5 pt-1" data-testid={testId}>
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-app-text-muted">{label}</span>
        <span className={`font-medium ${BAND_TEXT[chosen]}`} data-testid={`${testId}-value`}>{format(shown)}</span>
      </div>
      <input
        type="range"
        data-testid={`${testId}-slider`}
        data-band={chosen}
        aria-label={label}
        aria-valuetext={format(shown)}
        min={min}
        max={max}
        step={step}
        value={shown}
        // The band IS the track: `index.css` already strips the native look
        // from every range input and paints the thumb, so what is left to
        // paint is the 6px track, and it is painted with the shared band
        // function. Same height and radius as the app's other sliders.
        style={{ background: bandGradient(min, max, band) }}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-lg"
        onPointerDown={() => { dragging.current = true; }}
        onPointerUp={() => { dragging.current = false; if (draft != null) commit(draft); }}
        onPointerCancel={() => { dragging.current = false; if (draft != null) commit(draft); }}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (dragging.current) setDraft(v);
          else commit(v);
        }}
      />
      <p className={`text-[11px] leading-snug ${BAND_TEXT[chosen]}`} data-testid={`${testId}-band`}>{tr(words)}</p>
      <p
        className={`text-[11px] leading-snug ${liveBand ? BAND_TEXT[liveBand] : 'text-app-text-faint'}`}
        data-testid={`${testId}-live`}
        data-band={liveBand ?? 'none'}
      >{liveText}</p>
    </div>
  );
}
