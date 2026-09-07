/**
 * THE DISPATCHER LOAD, READ IN HALF A SECOND, without knowing what a core is.
 *
 * The board used to show the load only once it was already a problem: the advice
 * chip appears when running is above what the machine recommends and says "stop
 * N". At rest it says nothing, so whoever asks "why is that Todo card not
 * starting?" has no answer on screen.
 *
 * This module is the READING, not its drawing: how full the ring is, which tone
 * it takes, and WHICH WORD goes next to it. It lives apart from the component so
 * the three states can be asserted without a browser, and so the header, the
 * popover and the settings panel cannot disagree about the same machine.
 *
 * THE WORD IS THE POINT. A number needs a unit and a comparison to mean
 * anything; "full" needs neither. The numbers stay in the popover, for whoever
 * wants them.
 *
 * Nothing here decides the cap: the cap is `currentCapLimit`, the machine is the
 * probe, and this only turns the pair into something a person reads.
 */
import { capMode } from '../../lib/board';
import type { GlobalDispatchCapState } from '../../state/globalDispatchCap';
import { currentCapLimit } from '../../state/globalDispatchCap';

/** Neutral until the limit is reached, amber at it, rose past it. */
export type LoadTone = 'idle' | 'full' | 'over';

export interface DispatchLoadReading {
  /** Agents in flight right now (0 while the probe has not answered). */
  running: number;
  /**
   * The ceiling that applies NOW. `null` = not knowable yet (auto without a
   * probe), `Infinity` = the cap is off. Both are drawn, neither is invented.
   */
  limit: number | null;
  /** 0..1, what the ring fills. Over the limit it stays full: a ring cannot
   *  overflow, the tone is what says "past it". */
  fill: number;
  tone: LoadTone;
  /** True while the reading is still missing: empty ring, no verdict word. */
  loading: boolean;
  /** True when there IS no ceiling to fill against. */
  unbounded: boolean;
  /**
   * The brake is the budget, not a count. The numeric cap does not apply then,
   * so the fraction the ring draws is not "agents of a ceiling": it is core-
   * units of the budget, which is the number that actually decides. The word
   * beside it names the brake.
   */
  byResources: boolean;
  /**
   * In budget mode: what share of the WHOLE computer Topics is taking now, and
   * the share it is allowed. Both 0..1, both `null` when the probe has not
   * answered. They are what the popover turns into "Topics is using 62% of the
   * PC on an 80% budget", and they live here so the header, the popover and the
   * settings panel cannot disagree about the same machine.
   */
  usedShare: number | null;
  budgetShare: number | null;
  /** Check runs frozen for load right now (see the budget governor). */
  frozen: number;
}

export function dispatchLoadReading(s: GlobalDispatchCapState): DispatchLoadReading {
  const running = Math.max(0, s.capacity?.running ?? 0);
  const base = {
    running, fill: 0, tone: 'idle' as LoadTone, loading: false, unbounded: false, byResources: false,
    usedShare: null as number | null, budgetShare: null as number | null,
    frozen: Math.max(0, s.capacity?.frozen ?? 0),
  };
  if (s.cap && capMode(s.cap) === 'resources') {
    const c = s.capacity;
    // THE RING FILLS WITH THE BUDGET. It used to stay empty in this mode, on
    // the grounds that there was no count to be a fraction of, and the result
    // was a gauge that said nothing precisely in the mode whose whole point is
    // "how full is it". The fraction is use over budget; over the budget it
    // stays full and the tone is what says "past it".
    if (!c || c.usedCoreUnits == null || !(c.cores > 0)) {
      return { ...base, limit: null, byResources: true, loading: !c };
    }
    const ceiling = c.budgetCoreUnits > 0 ? c.budgetCoreUnits : 0;
    const fill = ceiling > 0 ? Math.min(1, c.usedCoreUnits / ceiling) : 0;
    const tone: LoadTone = ceiling > 0 && c.usedCoreUnits > ceiling
      ? 'over'
      : ceiling > 0 && c.usedCoreUnits >= ceiling ? 'full' : 'idle';
    return {
      ...base,
      limit: null,
      byResources: true,
      fill,
      tone,
      usedShare: c.usedCoreUnits / c.cores,
      budgetShare: c.budgetShare,
    };
  }
  const limit = currentCapLimit(s);
  if (limit === null) return { ...base, limit, loading: true };
  if (!Number.isFinite(limit)) return { ...base, limit, unbounded: true };
  const fill = limit > 0 ? Math.min(1, running / limit) : 1;
  const tone: LoadTone = running > limit ? 'over' : running >= limit ? 'full' : 'idle';
  return { ...base, limit, fill, tone };
}

/** The i18n key of the ONE word beside the ring. */
export function loadWordKey(r: DispatchLoadReading): string {
  if (r.loading) return 'board.gauge.reading';
  if (r.byResources) return 'board.gauge.byResources';
  if (r.unbounded) return 'board.gauge.noLimit';
  if (r.tone === 'over') return 'board.gauge.over';
  if (r.tone === 'full') return 'board.gauge.full';
  return 'board.gauge.light';
}

/** Ring stroke + word colour, one per tone. Kept next to the reading so a new
 *  tone can never be added without a colour. */
export function loadToneClass(r: DispatchLoadReading): string {
  if (r.loading || r.unbounded) return 'text-app-text-muted';
  if (r.tone === 'over') return 'text-rose-300';
  if (r.tone === 'full') return 'text-amber-300';
  return 'text-app-text-secondary';
}

/**
 * How the effective ceiling was reached, in the shape a person reads in the
 * popover: "12 cores -> 4". Only where the machine is what derived it: a number
 * somebody typed is its own explanation, and printing the cores next to it would
 * claim a causality that is not there.
 */
export function limitDerivation(s: GlobalDispatchCapState): { cores: number; limit: number } | null {
  if (!s.cap || capMode(s.cap) === 'resources') return null;
  const limit = currentCapLimit(s);
  if (limit === null || !Number.isFinite(limit)) return null;
  if (!s.cap.auto) return null;
  if (!s.capacity || !(s.capacity.cores > 0)) return null;
  return { cores: s.capacity.cores, limit };
}
