/**
 * THE DISPATCHER LOAD, IN THE HEADER OF "IN PROGRESS".
 *
 * WHAT WAS MISSING. The board only spoke about the load once it was already a
 * problem: `LoadAdviceChip` in the toolbar, and only above the recommendation.
 * At rest, silence — so whoever asks "why is that Todo card not starting?" had
 * nothing on screen to answer with. The number was there all along (the same
 * 15s probe the cap store already runs); nobody had ever drawn it.
 *
 * THE SHAPE, and why it is this one:
 *
 * 1. **A ring, not a percentage.** It sits next to the column count, at the size
 *    of a badge, and it is read peripherally: how full it is IS the message. A
 *    percentage would ask to be compared with something the reader does not have
 *    in mind.
 * 2. **One word, and it is not a unit.** "light", "full", "over the limit". No
 *    cores, no load average, no ratio: those need to be taught before they mean
 *    anything, and this thing has half a second. The numbers exist for whoever
 *    wants them, one click away in the popover.
 * 3. **No action on it.** Stopping agents is the advice chip's job, which stays
 *    exactly as it is. This one is a reading; the only thing it offers is the
 *    door to the settings, where the knob actually is.
 *
 * The same component draws itself in the settings panel (`variant="panel"`),
 * under the cap knobs: while you turn the knob you see what you are limiting,
 * and it is the same reading rather than a second one that can drift.
 */
import { useRef, useState } from 'react';
import { ChevronRight, Gauge } from 'lucide-react';
import { Menu } from '../Shared/Menu';
import { useT } from '../../hooks/useT';
import { useGlobalDispatchCap } from '../../state/globalDispatchCap';
import {
  admissionVerdictText, cpuPercent, dispatchLoadReading, limitDerivation,
  loadToneClass, loadWordKey, memPercent, pctTone, pctToneBarClass, pctToneTextClass,
  type DispatchLoadReading,
} from './dispatchLoad';
import { spendLabel } from './spendFormat';
import { budgetShare, capMode } from '../../lib/board';
import type { DispatchCapacity, GlobalDispatchCap } from '../../lib/board';

/** Ring geometry. `r` small enough to sit on a badge line, stroke thin enough
 *  that the FILL is what the eye catches and not the ring itself. */
const RADIUS = 6.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * The ring. `stroke-dasharray` is the fill, `stroke-dashoffset` stays at zero:
 * animating the array alone keeps the arc anchored at twelve o'clock while it
 * grows, which is what makes the 200ms transition read as "filling up" instead
 * of "sliding around".
 */
function LoadRing({ reading, size }: { reading: DispatchLoadReading; size: number }) {
  const dash = Math.max(0, Math.min(1, reading.fill)) * CIRCUMFERENCE;
  return (
    <svg
      viewBox="0 0 18 18"
      width={size}
      height={size}
      className="shrink-0"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="9" cy="9" r={RADIUS} fill="none" stroke="currentColor" strokeWidth="2" className="opacity-20" />
      <circle
        cx="9"
        cy="9"
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={`${dash} ${CIRCUMFERENCE}`}
        transform="rotate(-90 9 9)"
        style={{ transition: 'stroke-dasharray 200ms ease-out' }}
      />
    </svg>
  );
}

/** The whole sentence, for the hover title and for a screen reader: the word
 *  alone is the peripheral reading, not the accessible name. */
function gaugePhrase(
  reading: DispatchLoadReading,
  tr: (k: string, v?: Record<string, string | number>) => string,
): string {
  if (reading.loading) return tr('board.gauge.ariaReading');
  if (reading.byResources) {
    // Not measured yet is said as such, never as "0.0 of X".
    if (reading.usedShare == null) return tr('board.gauge.ariaReading');
    return tr('board.gauge.ariaResources', { running: reading.running, pct: pctOf(reading.usedShare) });
  }
  if (reading.unbounded) return tr('board.gauge.ariaNoLimit', { running: reading.running });
  return tr('board.gauge.aria', { running: reading.running, limit: reading.limit ?? 0 });
}

/** A share as a whole percentage, and `0` where nothing was measured. */
const pctOf = (share: number | null | undefined): number => Math.round(Math.max(0, share ?? 0) * 100);

/**
 * THE ONE GIGABYTE LINE. The wire carried memory all along and no surface of
 * the dispatch printed a single GB, so a queue held by memory showed a ring
 * filled with CPU and no number that explained it. What the gate compared:
 * our footprint, our share of the free memory, and what one more agent asks.
 * Only when the gate sent them.
 */
function memoryLine(cap: DispatchCapacity | null): { ours: string; free: string; cost: string } | null {
  const a = cap?.admission;
  if (!a || a.ourMemGB == null || a.freeQuotaMemGB == null || a.costMemGB == null) return null;
  return { ours: a.ourMemGB.toFixed(1), free: a.freeQuotaMemGB.toFixed(1), cost: a.costMemGB.toFixed(1) };
}

/** One of the two big numbers: the label, the percentage (or "not measured"),
 *  and the bar under it. Shared by the label text, so the caller supplies an
 *  already-translated label rather than a second i18n key per axis. */
function PctRow({ label, pct, notMeasuredLabel, testId }: {
  label: string;
  pct: number | null;
  /** Shown instead of a fake 0% when the axis was never read (memory off macOS). */
  notMeasuredLabel: string;
  testId: string;
}) {
  const tone = pctTone(pct);
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-mini text-app-text-muted">{label}</span>
        <span
          className={`text-compact font-semibold tabular-nums ${pctToneTextClass(tone)}`}
          data-testid={testId}
        >
          {pct == null ? notMeasuredLabel : `${pct}%`}
        </span>
      </div>
      <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full rounded-full transition-[width] ${pctToneBarClass(tone)}`}
          style={{ width: `${pct ?? 0}%` }}
        />
      </div>
    </div>
  );
}

/**
 * THE TWO BIG NUMBERS: CPU and memory, as a share of the WHOLE Mac, not of
 * Topics' own budget. Exported so `GlobalCapControl.tsx` draws the identical
 * card next to the knob it is about to turn, rather than a second reading
 * that could drift from this one (the same reason `DispatchLoadSummary`
 * exists: one function decides, every surface only draws it).
 */
export function LoadPercentCard({ cap }: { cap: DispatchCapacity | null }) {
  const tr = useT();
  const cpu = cpuPercent(cap);
  const mem = memPercent(cap);
  return (
    <div className="flex gap-3" data-testid="dispatch-load-pct-card">
      <PctRow
        label={tr('board.gauge.cpuLabel')}
        pct={cpu}
        notMeasuredLabel={tr('board.gauge.notMeasured')}
        testId="dispatch-load-cpu-pct"
      />
      <PctRow
        label={tr('board.gauge.memLabel')}
        pct={mem}
        notMeasuredLabel={tr('board.gauge.notMeasured')}
        testId="dispatch-load-mem-pct"
      />
    </div>
  );
}

/** "Agents working N / max M": the one line every mode can print, worded
 *  for whichever cap applies. `limit` is `null` while still loading, `Infinity`
 *  when the brake is off, a number in count mode, and never derived here in
 *  resources mode (there is no fixed count to be "of"). */
function agentsLineKey(reading: DispatchLoadReading): { key: string; params: Record<string, number> } {
  if (!reading.loading && !reading.byResources && reading.limit != null && Number.isFinite(reading.limit)) {
    return { key: 'board.gauge.agentsOfMax', params: { running: reading.running, max: reading.limit } };
  }
  if (!reading.loading && !reading.byResources && reading.unbounded) {
    return { key: 'board.gauge.agentsNoLimit', params: { running: reading.running } };
  }
  return { key: 'board.gauge.agentsPlain', params: { running: reading.running } };
}

/** What the DOM says the state is, for whoever reads it without pixels (the
 *  e2e, and anything that has to tell the five apart). */
function toneAttr(r: DispatchLoadReading): string {
  if (r.loading) return 'loading';
  if (r.byResources) return 'resources';
  if (r.unbounded) return 'unbounded';
  return r.tone;
}

/** Which brake produced the ceiling, said in words before any number. */
function modeLine(cap: GlobalDispatchCap | null, tr: (k: string, v?: Record<string, string | number>) => string): string {
  if (!cap) return tr('board.gauge.modeAuto');
  if (capMode(cap) === 'resources') return tr('board.gauge.modeResources', { pct: pctOf(budgetShare(cap)) });
  if (cap.auto) return tr('board.gauge.modeAuto');
  if (cap.max === 0) return tr('board.gauge.modeOff');
  return tr('board.gauge.modeFixed');
}

/**
 * The gauge in the column header: ring + word, and a popover with the numbers.
 * `onOpenSettings` is the door to the knob; without it the button is simply not
 * drawn, because a dead-end "Settings" is worse than none.
 */
export function DispatchLoadGauge({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const tr = useT();
  const s = useGlobalDispatchCap();
  const reading = dispatchLoadReading(s);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const cap = s.capacity;
  const phrase = gaugePhrase(reading, tr);
  const derived = limitDerivation(s);
  const mem = reading.byResources ? memoryLine(cap) : null;
  const verdict = reading.heldBy && cap?.admission ? admissionVerdictText(cap.admission, cap) : null;
  const agents = agentsLineKey(reading);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        data-testid="dispatch-load-gauge"
        data-tone={toneAttr(reading)}
        data-held={reading.heldBy ?? 'none'}
        data-fill={reading.fill.toFixed(2)}
        role="meter"
        aria-valuenow={reading.running}
        aria-valuemin={0}
        aria-valuemax={reading.limit != null && Number.isFinite(reading.limit) ? reading.limit : undefined}
        aria-label={phrase}
        title={phrase}
        className={`flex items-center gap-1 rounded px-1 py-0.5 text-micro font-medium normal-case tracking-normal tabular-nums hover:bg-white/10 ${loadToneClass(reading)}`}
      >
        <LoadRing reading={reading} size={12} />
        <span data-testid="dispatch-load-word">{tr(loadWordKey(reading))}</span>
      </button>
      <Menu open={open} anchorRef={btnRef} onClose={() => setOpen(false)} minWidth={264} testId="dispatch-load-popover">
        <div className="space-y-2 px-3 py-2.5 text-mini leading-snug text-app-text-secondary">
          <p className="flex items-center gap-1.5 text-compact font-medium text-app-text-heading">
            <Gauge className="h-3.5 w-3.5 shrink-0" />
            {tr('board.gauge.popoverTitle')}
          </p>

          {/* THE TWO BIG NUMBERS people came for: CPU and memory of the WHOLE
              Mac, never Topics' own budget in cores. */}
          <LoadPercentCard cap={cap} />

          <p className="tabular-nums">{tr(agents.key, agents.params)}</p>

          {/* What holds admission, in a plain sentence with its percentage:
              the ring already says the axis in one word, this says why in
              numbers a person already owns. */}
          {verdict && (
            <p className="tabular-nums text-rose-300" data-testid="dispatch-load-verdict" title={verdict.title}>
              {tr(verdict.key, verdict.params)}
            </p>
          )}

          {/* WHAT IS TRUE BUT NOT READ AT EVERY OPENING: the brake mechanics,
              the raw core-unit/GB numbers for whoever wants them, folded away
              like `GlobalCapControl`'s own "How it works" so the two surfaces
              share the same disclosure pattern. */}
          <details className="group" data-testid="dispatch-load-details">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-mini text-app-text-muted hover:text-app-text-secondary">
              <ChevronRight size={10} className="transition-transform group-open:rotate-90" aria-hidden="true" />
              {tr('board.gauge.details')}
            </summary>
            <div className="mt-1 space-y-1.5 text-mini leading-snug">
              <p className="tabular-nums">
                {modeLine(s.cap, tr)}
                {derived && <span data-testid="dispatch-load-derivation">{' · '}{tr('board.gauge.derived', { cores: derived.cores, limit: derived.limit })}</span>}
              </p>
              {reading.byResources && reading.usedShare != null && (
                <p className="tabular-nums" data-testid="dispatch-load-budget">
                  {tr('board.gauge.budgetLine', { pct: Math.round((reading.usedShare ?? 0) * 100) })}
                </p>
              )}
              {mem && <p className="tabular-nums" data-testid="dispatch-load-memory">{tr('board.gauge.memLine', mem)}</p>}
              {reading.frozen > 0 && <p className="tabular-nums">{tr('board.gauge.frozen', { n: reading.frozen })}</p>}
              {s.spend && (
                <p className="tabular-nums">{tr('board.gauge.spendToday', { amount: spendLabel(s.spend.cents24h) })}</p>
              )}
            </div>
          </details>

          {onOpenSettings && (
            <button
              type="button"
              data-testid="dispatch-load-settings"
              onClick={() => { setOpen(false); onOpenSettings(); }}
              className="mt-1 w-full rounded bg-white/5 px-2 py-1 text-mini text-app-text-secondary hover:bg-white/10"
            >{tr('board.gauge.settings')}</button>
          )}
        </div>
      </Menu>
    </>
  );
}

/**
 * The same reading in the settings panel, beside the live count: the ring and
 * the word, nothing else. The numbers are already on the line it sits on, and
 * repeating them underneath is what made the panel read three times the same.
 */
export function DispatchLoadSummary() {
  const tr = useT();
  const s = useGlobalDispatchCap();
  const reading = dispatchLoadReading(s);

  return (
    <span
      className={`flex shrink-0 items-center gap-1 text-mini font-medium tabular-nums ${loadToneClass(reading)}`}
      data-testid="dispatch-load-summary"
      data-tone={toneAttr(reading)}
      data-held={reading.heldBy ?? 'none'}
      data-fill={reading.fill.toFixed(2)}
      title={gaugePhrase(reading, tr)}
    >
      <LoadRing reading={reading} size={12} />
      <span>{tr(loadWordKey(reading))}</span>
    </span>
  );
}
