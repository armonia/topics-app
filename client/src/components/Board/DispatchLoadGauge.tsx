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
import { capMode } from '../../lib/board';
import type { GlobalDispatchCap } from '../../lib/board';

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
function gaugePhrase(reading: DispatchLoadReading, tr: (k: string, v?: Record<string, string | number>) => string): string {
  if (reading.loading) return tr('board.gauge.ariaReading');
  if (reading.byResources) return tr('board.gauge.ariaResources', { running: reading.running });
  if (reading.unbounded) return tr('board.gauge.ariaNoLimit', { running: reading.running });
  return tr('board.gauge.aria', { running: reading.running, limit: reading.limit ?? 0 });
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
function modeKey(cap: GlobalDispatchCap | null): string {
  if (!cap) return 'board.gauge.modeAuto';
  if (capMode(cap) === 'resources') return 'board.gauge.modeResources';
  if (cap.auto) return 'board.gauge.modeAuto';
  if (cap.max === 0) return 'board.gauge.modeOff';
  return 'board.gauge.modeFixed';
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
  const phrase = gaugePhrase(reading, tr);
  const derived = limitDerivation(s);
  const cap = s.capacity;

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
        className={`flex items-center gap-1 rounded px-1 py-0.5 text-[10px] font-medium normal-case tracking-normal tabular-nums hover:bg-white/10 ${loadToneClass(reading)}`}
      >
        <LoadRing reading={reading} size={12} />
        <span data-testid="dispatch-load-word">{tr(loadWordKey(reading))}</span>
      </button>
      <Menu open={open} anchorRef={btnRef} onClose={() => setOpen(false)} minWidth={264} testId="dispatch-load-popover">
        <div className="space-y-1.5 px-3 py-2.5 text-[11px] leading-snug text-app-text-secondary">
          <p className="flex items-center gap-1.5 text-[12px] font-medium text-app-text-heading">
            <Gauge className="h-3.5 w-3.5 shrink-0" />
            {tr('board.gauge.popoverTitle')}
          </p>
          <p className="tabular-nums">
            {tr(modeKey(s.cap))}
            {derived && <span data-testid="dispatch-load-derivation">{' · '}{tr('board.gauge.derived', { cores: derived.cores, limit: derived.limit })}</span>}
          </p>
          <p className="tabular-nums">{tr('board.gauge.inFlight', { running: reading.running })}</p>
          {cap && cap.oursCores != null && (
            <p className="tabular-nums">{tr('board.gauge.fleetCores', { ours: cap.oursCores.toFixed(1), budget: cap.budgetCores.toFixed(0) })}</p>
          )}
          {cap && (
            <p className="tabular-nums">{tr('board.gauge.machineLoad', { load: cap.load1.toFixed(1), cores: cap.cores })}</p>
          )}
          {cap && cap.availableMemGB != null && (
            <p className="tabular-nums">{tr('board.gauge.freeMem', { free: cap.availableMemGB.toFixed(0), total: cap.totalMemGB.toFixed(0) })}</p>
          )}
          {s.spend && (
            <p className="tabular-nums">{tr('board.gauge.spendToday', { amount: spendLabel(s.spend.cents24h) })}</p>
          )}
          {cap?.reason && <p className="text-app-text-muted">{cap.reason}</p>}
          {onOpenSettings && (
            <button
              type="button"
              data-testid="dispatch-load-settings"
              onClick={() => { setOpen(false); onOpenSettings(); }}
              className="mt-1 w-full rounded bg-white/5 px-2 py-1 text-[11px] text-app-text-secondary hover:bg-white/10"
            >{tr('board.gauge.settings')}</button>
          )}
        </div>
      </Menu>
    </>
  );
}

/**
 * The same reading in the settings panel, under the knobs: no popover, no
 * button. The ring and the count say what the knob is doing, the row of numbers
 * says against what.
 */
export function DispatchLoadSummary() {
  const tr = useT();
  const s = useGlobalDispatchCap();
  const reading = dispatchLoadReading(s);
  const cap = s.capacity;
  const numbers: string[] = [];
  if (cap && cap.oursCores != null) numbers.push(tr('board.gauge.fleetCores', { ours: cap.oursCores.toFixed(1), budget: cap.budgetCores.toFixed(0) }));
  if (cap) numbers.push(tr('board.gauge.machineLoad', { load: cap.load1.toFixed(1), cores: cap.cores }));
  if (cap && cap.availableMemGB != null) numbers.push(tr('board.gauge.freeMem', { free: cap.availableMemGB.toFixed(0), total: cap.totalMemGB.toFixed(0) }));

  return (
    <div className="space-y-0.5 pt-1" data-testid="dispatch-load-summary">
      <p
        className={`flex items-center gap-1.5 text-[11px] font-medium tabular-nums ${loadToneClass(reading)}`}
        data-tone={toneAttr(reading)}
        data-fill={reading.fill.toFixed(2)}
      >
        <LoadRing reading={reading} size={12} />
        <span data-testid="dispatch-load-summary-count">
          {/* The fraction ONLY where it decides something. Over the ceiling
              "4 of 2" reads as a progress out of a total (the panel has banned
              that reading since KANBAN-07), and under the resources brake there
              is no count to be a fraction of. */}
          {reading.loading
            ? tr('board.gauge.reading')
            : reading.unbounded
              ? tr('board.gauge.ariaNoLimit', { running: reading.running })
              : reading.byResources || reading.tone === 'over'
                ? tr('board.gauge.inFlight', { running: reading.running })
                : tr('board.gauge.ofLimit', { running: reading.running, limit: reading.limit ?? 0 })}
        </span>
        <span className="text-app-text-muted">{tr(loadWordKey(reading))}</span>
      </p>
      {numbers.length > 0 && (
        <p className="text-[10px] leading-snug text-app-text-tertiary tabular-nums">{numbers.join(' · ')}</p>
      )}
    </div>
  );
}
