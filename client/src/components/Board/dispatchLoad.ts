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
import { ADMIT_RESUME_FRACTION, capMode } from '../../lib/board';
import type { DispatchAdmission, DispatchCapacity } from '../../lib/board';
import type { GlobalDispatchCapState } from '../../state/globalDispatchCap';
import { machineBusyPct, machineMemPct, pctPlaceholders } from '../../lib/machineBusy';
import { currentCapLimit } from '../../state/globalDispatchCap';

/** Which brake is holding new agents right now, as the gate said it. */
export type HeldBy = NonNullable<DispatchAdmission['blockedBy']>;

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
  /**
   * THE GATE IS HOLDING, and on which axis: `admission` said no. The ring used
   * to fill with the CPU alone and say "a budget" (or "3 of 4") whatever held,
   * so memory or the 6 GB floor holding the queue drew a ring with room in it.
   * When set, the ring is full, the tone is at least `full` (`over` for the
   * floor and a drain, which do not wait for a share to free up) and the word
   * names the axis. `null` = nothing holds, or no verdict on the wire.
   */
  heldBy: HeldBy | null;
}

/**
 * THE CORES AS THE GATE COUNTED THEM: the probe plus the turns admitted in the
 * last ninety seconds, against the ceiling it admitted against. The capacity's
 * own `usedCoreUnits` is the bare probe, and printing it next to the gate's
 * verdict drew "2.0 of 6.6" beside "new ones wait" while the card said "6.5 of
 * 6.6". Without the gate's numbers (an old server, count mode, the floor) the
 * probe is what there is, and nothing is said as pending.
 */
export function gateCoreNumbers(c: DispatchCapacity | null): { used: number | null; usable: number; pending: number } {
  const a = c?.admission;
  if (a && a.usedCoreUnits != null && a.usableCoreUnits != null) {
    return { used: a.usedCoreUnits, usable: Math.max(0, a.usableCoreUnits), pending: Math.max(0, a.pendingAdmissions ?? 0) };
  }
  return { used: c?.usedCoreUnits ?? null, usable: Math.max(0, c?.usableCoreUnits ?? 0), pending: 0 };
}

/** Who is holding, from the verdict on the wire. A pass is not a hold. */
function heldByOf(c: DispatchCapacity | null): HeldBy | null {
  const a = c?.admission;
  return a && !a.admit && a.blockedBy ? a.blockedBy : null;
}

/** The reading, once the gate says it holds: full ring, a tone that says so. */
function withHold(r: DispatchLoadReading): DispatchLoadReading {
  if (!r.heldBy || r.loading) return r;
  const hard = r.heldBy === 'floor' || r.heldBy === 'drain';
  return { ...r, fill: 1, tone: hard || r.tone === 'over' ? 'over' : 'full' };
}

export function dispatchLoadReading(s: GlobalDispatchCapState): DispatchLoadReading {
  return withHold(bareReading(s));
}

function bareReading(s: GlobalDispatchCapState): DispatchLoadReading {
  const running = Math.max(0, s.capacity?.running ?? 0);
  const base = {
    running, fill: 0, tone: 'idle' as LoadTone, loading: false, unbounded: false, byResources: false,
    usedShare: null as number | null, budgetShare: null as number | null,
    frozen: Math.max(0, s.capacity?.frozen ?? 0),
    heldBy: heldByOf(s.capacity),
  };
  if (s.cap && capMode(s.cap) === 'resources') {
    const c = s.capacity;
    // THE RING FILLS WITH THE BUDGET. It used to stay empty in this mode, on
    // the grounds that there was no count to be a fraction of, and the result
    // was a gauge that said nothing precisely in the mode whose whole point is
    // "how full is it". The fraction is use over budget; over the budget it
    // stays full and the tone is what says "past it".
    const gate = gateCoreNumbers(c);
    if (!c || gate.used == null || !(c.cores > 0)) {
      return { ...base, limit: null, byResources: true, loading: !c };
    }
    // Against the USABLE ceiling, the one the gate admits against: the share
    // of what the rest of the machine leaves free. Filling against the whole
    // budget drew a half-empty ring while the gate was already saying "wait".
    // A measured ZERO is a real ceiling (the others hold the whole machine),
    // not a missing one: falling back to the budget there drew an almost empty
    // ring while the gate refused every card. Use and ceiling are the gate's
    // own when it sent them (`gateCoreNumbers`).
    const ceiling = gate.usable;
    const used = gate.used;
    const fill = ceiling > 0 ? Math.min(1, used / ceiling) : used > 0 ? 1 : 0;
    const tone: LoadTone = used > ceiling
      ? 'over'
      : ceiling > 0 && used >= ceiling ? 'full' : 'idle';
    return {
      ...base,
      limit: null,
      byResources: true,
      fill,
      tone,
      usedShare: used / c.cores,
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
  // The axis that holds, before the name of the brake: "a budget" beside a ring
  // while memory held the queue was the one word that answered nothing.
  if (r.heldBy) return `board.gauge.wait.${r.heldBy}`;
  if (r.byResources) return 'board.gauge.byResources';
  if (r.unbounded) return 'board.gauge.noLimit';
  if (r.tone === 'over') return 'board.gauge.over';
  if (r.tone === 'full') return 'board.gauge.full';
  return 'board.gauge.light';
}

/** Ring stroke + word colour, one per tone. Kept next to the reading so a new
 *  tone can never be added without a colour. */
export function loadToneClass(r: DispatchLoadReading): string {
  if (r.loading) return 'text-app-text-muted';
  // Tone before "unbounded": no ceiling is neutral only while nothing holds, and
  // an unbounded reading has no tone of its own except the one a hold gives it.
  if (r.tone === 'over') return 'text-rose-300';
  if (r.tone === 'full') return 'text-amber-300';
  if (r.unbounded) return 'text-app-text-muted';
  return 'text-app-text-secondary';
}

/**
 * THE VERDICT, IN WORDS WITH ITS NUMBERS: the one sentence the panel and the
 * popover print for `admission`. It names the axis and the two numbers that
 * axis compared, so "new ones wait" is never a bare claim beside a reading
 * that shows room. Every branch has a fallback without numbers, for a server
 * that sends only the verdict.
 */
export interface VerdictText {
  key: string;
  params?: Record<string, string | number>;
  /** `go` green, `first` amber (a pass owed only to an empty fleet), `wait` red. */
  tone: 'go' | 'first' | 'wait';
  /** The whole sentence the brake composed, for a hover title. */
  title?: string;
}

/**
 * The verdict as the sentence on screen. Its numbers are percentages and the
 * Italian sentence needs each one with its article ("all'88%"), which depends
 * on the language being drawn: so the caller passes it, and every surface that
 * prints a verdict prints the same words.
 */
export function verdictSentence(
  v: VerdictText,
  tr: (k: string, vars?: Record<string, string | number>) => string,
  locale: 'it' | 'en',
): string {
  const nums: Record<string, number> = {};
  for (const [k, n] of Object.entries(v.params ?? {})) if (typeof n === 'number') nums[k] = n;
  return tr(v.key, { ...v.params, ...pctPlaceholders(locale, nums) });
}

/**
 * THE VERDICT, IN THE ONE NUMBER: "Waiting: the Mac is 92% busy". Core-units
 * and gigabytes stay the gate's private currency; the sentence speaks in the
 * same percentage as the headline of every load surface (`machineBusyPct`),
 * so "held" and "how busy" are never said in two units.
 *
 * THE RESUME CLAUSE ("starts by itself under X%") is printed only where it is
 * honest, and that is narrower than it looks. The gate decides on TOPICS'
 * share, the headline is the WHOLE Mac; the two meet only through the drop
 * the gate needs, which is the same amount of the machine whichever way it is
 * counted. So the resume point is the headline minus that drop, and only:
 *  - when the axis that holds is the axis that makes the headline (a memory
 *    hold under a CPU-made 92% says nothing about where the 92% goes);
 *  - when the gate sent its numbers, and the drop is inside the machine.
 * CPU: once holding, the gate reopens when use plus one more agent is under
 * 80% of the usable, so the drop is `used + cost - 0.8 x usable` core-units.
 * Memory, footprint clause: our tree over its ceiling, the drop is
 * `ours - ceiling` GB. The quota clause depends on the next agent's price and
 * on the free memory at once, so no single line exists and none is printed.
 */
export function admissionVerdictText(a: DispatchAdmission, cap: DispatchCapacity | null): VerdictText {
  if (a.admit) {
    return a.firstAgentExempt
      ? { key: 'board.dispatch.verdictFirst', tone: 'first' }
      : { key: 'board.dispatch.verdictGo', tone: 'go' };
  }
  const wait = (key: string, params?: Record<string, string | number>): VerdictText =>
    ({ key, params, tone: 'wait', title: a.reason ?? undefined });
  // The floor (disk or memory under the hard line) and a planned restart hold
  // the whole machine. The server's own sentence carries GB and stays one
  // hover away in `title`; the line says what it means in plain words.
  if (a.blockedBy === 'floor') return wait('board.dispatch.verdictWaitFloor');
  if (a.blockedBy === 'drain') return wait('board.dispatch.verdictWaitDrain');
  const pct = machineBusyPct(cap);
  if (pct == null) return wait('board.dispatch.verdictWaitBusyUnknown');
  const resume = resumePct(a, cap, pct);
  return resume == null
    ? wait('board.dispatch.verdictWaitBusy', { pct })
    : wait('board.dispatch.verdictWaitBusyResume', { pct, resume });
}

/** Where the headline has to fall for the gate to reopen, or `null` when that
 *  point is not honestly derivable (see `admissionVerdictText`). */
function resumePct(a: DispatchAdmission, cap: DispatchCapacity | null, pct: number): number | null {
  if (!cap) return null;
  const cpu = cap.machineCpuPct ?? null;
  const mem = machineMemPct(cap);
  let dropPct: number | null = null;
  if (a.blockedBy === 'cpu') {
    if (cpu == null || cpu < pct || !(cap.cores > 0)) return null;
    const { usedCoreUnits: used, usableCoreUnits: usable } = a;
    if (used == null || usable == null) return null;
    dropPct = ((used + a.costCoreUnits - usable * ADMIT_RESUME_FRACTION) / cap.cores) * 100;
  } else if (a.blockedBy === 'memory') {
    if (mem == null || Math.round(mem) < pct || !(cap.totalMemGB > 0)) return null;
    if (a.memClause !== 'footprint' || a.ourMemGB == null || a.usableMemGB == null) return null;
    dropPct = ((a.ourMemGB - a.usableMemGB) / cap.totalMemGB) * 100;
  }
  if (dropPct == null || !(dropPct > 0) || dropPct >= pct) return null;
  return Math.round(pct - dropPct);
}

/**
 * THE ADVICE CHIP'S ARITHMETIC ("stop N"), and the one brake it applies to.
 *
 * `running - recommended` is a question about the COUNT brake: in "per
 * risorse" the number does not apply (KANBAN-75), `recommended` is still the
 * count-mode figure, and the chip drew a red "Fermane 12" on a machine whose
 * gate was admitting the next agent. There the gauge names the axis that holds,
 * so the chip says nothing. An unread mode says nothing either: advice on a
 * brake that may not be the one in force is the same false alarm.
 */
export function loadAdvice(s: GlobalDispatchCapState): { over: number; severe: boolean } | null {
  const cap = s.capacity;
  if (!cap || !s.cap || capMode(s.cap) === 'resources') return null;
  const over = (cap.running ?? 0) - cap.recommended;
  if (over <= 0) return null;
  // The fleet's own CPU is the honest signal (dispatch-capacity.ts): the load
  // average of the whole machine speaks mostly of the person's own apps.
  const beyondQuota = cap.oursCores != null && cap.budgetCores > 0 && cap.oursCores >= cap.budgetCores;
  const severe = beyondQuota || over >= 2 || (cap.oursCores == null && cap.cores > 0 && cap.load1 / cap.cores >= 1.3);
  return { over, severe };
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

/**
 * What the checks-floor box shows. A draft under the finger wins, empty draft
 * included: somebody clearing the box to type must not have a value put back
 * under them.
 *
 * `null` is "not read yet", and it must NOT paint as 0: zero is "the brake is
 * off", and telling the owner their brake is disabled while the first GET is
 * still in flight is a lie that looks like a setting. It lives here rather than
 * in the component both because a component file that exports a function loses
 * fast refresh, and because the store is a module store: once anything has
 * adopted a value no mounted component can be put back to "never read", so this
 * rule is only testable as a function.
 */
export function checksFloorBoxValue(floor: number | null, draft?: string): string {
  if (draft !== undefined) return draft;
  return floor == null ? '' : String(floor);
}
