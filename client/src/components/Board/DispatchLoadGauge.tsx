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
import { Gauge } from 'lucide-react';
import { Menu } from '../Shared/Menu';
import { useT } from '../../hooks/useT';
import { useGlobalDispatchCap } from '../../state/globalDispatchCap';
import { dispatchLoadReading, limitDerivation, loadToneClass, loadWordKey, type DispatchLoadReading } from './dispatchLoad';
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
  cap: DispatchCapacity | null,
  tr: (k: string, v?: Record<string, string | number>) => string,
): string {
  if (reading.loading) return tr('board.gauge.ariaReading');
  if (reading.byResources) {
    return tr('board.gauge.ariaResources', { running: reading.running, ...coreNumbers(cap) });
  }
  if (reading.unbounded) return tr('board.gauge.ariaNoLimit', { running: reading.running });
  return tr('board.gauge.aria', { running: reading.running, limit: reading.limit ?? 0 });
}

/** A share as a whole percentage, and `0` where nothing was measured. */
const pctOf = (share: number | null | undefined): number => Math.round(Math.max(0, share ?? 0) * 100);

/** What Topics holds and what it may hold, in cores, as the two strings every
 *  budget line prints. "May hold" is the usable ceiling (the share of what the
 *  rest of the machine leaves free), the same number the gate admits against. */
function coreNumbers(cap: DispatchCapacity | null): { used: string; usable: string } {
  const usable = cap ? (cap.usableCoreUnits > 0 ? cap.usableCoreUnits : cap.budgetCoreUnits) : 0;
  return { used: (cap?.usedCoreUnits ?? 0).toFixed(1), usable: usable.toFixed(1) };
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
  const phrase = gaugePhrase(reading, cap, tr);
  const derived = limitDerivation(s);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        data-testid="dispatch-load-gauge"
        data-tone={toneAttr(reading)}
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
        <div className="space-y-1.5 px-3 py-2.5 text-mini leading-snug text-app-text-secondary">
          <p className="flex items-center gap-1.5 text-compact font-medium text-app-text-heading">
            <Gauge className="h-3.5 w-3.5 shrink-0" />
            {tr('board.gauge.popoverTitle')}
          </p>
          <p className="tabular-nums">
            {modeLine(s.cap, tr)}
            {derived && <span data-testid="dispatch-load-derivation">{' · '}{tr('board.gauge.derived', { cores: derived.cores, limit: derived.limit })}</span>}
          </p>
          {/* ONE LINE OF NUMBERS, not four. Agents and cores together in the
              budget mode; the count alone otherwise. The percentage of the PC
              and the core-units line used to say the same thing twice, and
              the server's `reason` a third time. */}
          {reading.byResources && reading.usedShare != null ? (
            <p className="tabular-nums" data-testid="dispatch-load-budget">
              {tr('board.gauge.budgetLine', { running: reading.running, ...coreNumbers(cap) })}
            </p>
          ) : (
            <p className="tabular-nums">{tr('board.gauge.inFlight', { running: reading.running })}</p>
          )}
          {reading.frozen > 0 && <p className="tabular-nums">{tr('board.gauge.frozen', { n: reading.frozen })}</p>}
          {s.spend && (
            <p className="tabular-nums">{tr('board.gauge.spendToday', { amount: spendLabel(s.spend.cents24h) })}</p>
          )}
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
      data-fill={reading.fill.toFixed(2)}
      title={gaugePhrase(reading, s.capacity, tr)}
    >
      <LoadRing reading={reading} size={12} />
      <span>{tr(loadWordKey(reading))}</span>
    </span>
  );
}
