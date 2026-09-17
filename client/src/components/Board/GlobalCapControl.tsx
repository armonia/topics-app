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
 * ONE LIVE LINE, THE REST ON REQUEST (14/09). The panel used to say the same
 * reading three times (the running line, the live line under the slider, the
 * summary under everything) and four paragraphs of how-it-works around it. What
 * is read at every opening stays in sight: how many are working, the knob, one
 * line of numbers with its verdict. The explanations sit under "How it works".
 *
 * ONE COMPONENT, EVERY SURFACE. The title menu and the settings panel mount
 * THIS, not two copies: state lives in `state/globalDispatchCap.ts` and every
 * write goes through `saveGlobalCap`. That is why a change made in one shows up
 * in the other without a reload, and why another window's `board:global-cap`
 * broadcast enters through a single door.
 */
import { useRef, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { useT } from '../../hooks/useT';
import {
  GLOBAL_CAP_MAX, GLOBAL_CAP_MIN, GLOBAL_CAP_OFF,
  budgetShare, capMode, livePressureBand,
  BUDGET_SHARE_MIN, BUDGET_SHARE_MAX,
  CHECKS_MEM_FLOOR_MIN_GB, CHECKS_MEM_FLOOR_MAX_GB, checksMemFloorIsOff,
} from '../../lib/board';
import type { DispatchAdmission, DispatchCapMode, ThresholdBand } from '../../lib/board';
import { DANGER_TEXT, SUCCESS_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { DispatchLoadSummary } from './DispatchLoadGauge';
import { admissionVerdictText, checksFloorBoxValue, gateCoreNumbers, type VerdictText } from './dispatchLoad';
import {
  currentCapLimit,
  saveChecksFloor,
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

      {/* OUTSIDE the two brakes on purpose: this one does not gate agents, it
          gates the check COMMANDS a delivery runs before review, and it applies
          whichever question the brake above is asking. */}
      <ChecksFloorField />
    </div>
  );
}

/**
 * HOW MUCH FREE MEMORY A CHECK COMMAND NEEDS before the server spawns it.
 *
 * WHY IT IS A FIELD AT ALL, and not the constant it replaced. It used to be
 * `DISPATCH_MEM_FLOOR_NATIVE_GB` = 6 GB, which is the floor for admitting an
 * AGENT, borrowed by the checks brake and never measured against a check: three
 * times the heaviest command on the machine (`lint` cold, 1.9 GB), it held the
 * round back in 86.2% of 1828 readings and every delivery paid up to three
 * minutes of valve for a shortage that never happened. A number nobody can see
 * is a number nobody corrects when the load changes.
 *
 * SO IT SAYS WHAT IT IS CALIBRATED AGAINST, not just its own value. The hint
 * names the most expensive measured command and its cost, which is the one fact
 * that lets somebody move this knob on purpose instead of by feel.
 */
function ChecksFloorField() {
  const tr = useT();
  const s = useGlobalDispatchCap();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const floor = s.checksFloorGB;
  const shown = checksFloorBoxValue(floor, draft);
  const commit = (raw: string) => {
    setDraft(undefined);
    const n = Number(raw);
    // An empty or unreadable box is not a write: it is somebody who cleared the
    // field and clicked away, and the value that was there stays.
    if (raw.trim() === '' || !Number.isFinite(n)) return;
    void saveChecksFloor(n);
  };

  return (
    <div className="space-y-1 pt-1.5" data-testid="checks-floor-control">
      <p className="text-micro font-semibold uppercase tracking-wide text-app-text-muted">
        {tr('board.checksFloor.title')}
      </p>
      <label className="flex items-center justify-between gap-3">
        <span className="text-mini text-app-text-muted">{tr('board.checksFloor.field')}</span>
        <input
          type="number"
          min={CHECKS_MEM_FLOOR_MIN_GB}
          max={CHECKS_MEM_FLOOR_MAX_GB}
          step={1}
          data-testid="checks-floor-gb"
          value={shown}
          disabled={s.saving || floor == null}
          onChange={(e) => { const v = e.target.value; setDraft(v); }}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') commit((e.target as HTMLInputElement).value); }}
          className="w-20 shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-right text-app-text outline-none"
        />
      </label>
      {/* OFF IS A STATE WITH A NAME. A numeric field that changes meaning at one
          end has to say so, or the only way to learn what 0 does is to read the
          server. */}
      <p className="text-mini leading-snug text-app-text-faint" data-testid="checks-floor-hint">
        {floor != null && checksMemFloorIsOff(floor)
          ? tr('board.checksFloor.off')
          : tr('board.checksFloor.hint')}
      </p>
    </div>
  );
}

/**
 * The live count, with THE SAME READING AS THE COLUMN HEADER beside it: the
 * ring and its word. Same store, same words, so the two surfaces cannot start
 * disagreeing about the same machine.
 */
function RunningLine({ className, children }: { className: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <p data-testid="global-cap-running" className={`text-compact font-medium ${className}`}>{children}</p>
      <DispatchLoadSummary />
    </div>
  );
}

const VERDICT_TEXT: Record<VerdictText['tone'], string> = { go: SUCCESS_TEXT, first: WARNING_TEXT, wait: DANGER_TEXT };

/**
 * The gate's verdict, in the words of `admissionVerdictText`: the axis that
 * holds and the two numbers it compared. The composed sentence of the floor
 * stays one hover away, the panel keeps its one line.
 */
function Verdict({ admission }: { admission: DispatchAdmission }) {
  const tr = useT();
  const v = admissionVerdictText(admission);
  return (
    <span
      data-testid="global-cap-verdict"
      data-admit={admission.admit}
      data-blocked-by={admission.blockedBy ?? 'none'}
      title={v.title}
      className={`font-medium ${VERDICT_TEXT[v.tone]}`}
    >{tr(v.key, v.params)}</span>
  );
}

/** What is true but not read at every opening: closed until asked for. */
function HowItWorks({ children }: { children: ReactNode }) {
  const tr = useT();
  return (
    <details className="group" data-testid="global-cap-details">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-mini text-app-text-muted hover:text-app-text-secondary">
        <ChevronRight size={10} className="transition-transform group-open:rotate-90" aria-hidden="true" />
        {tr('board.dispatch.howItWorks')}
      </summary>
      <div className="mt-1 space-y-1 text-mini leading-snug text-app-text-faint">{children}</div>
    </details>
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
          read. */}
      <RunningLine className={full ? 'text-amber-300' : 'text-app-text-heading'}>
        {limit === null
          ? tr('board.dispatch.runningLoading')
          : !bounded
            // "8 di Infinity" is what a bare interpolation would print here.
            ? tr('board.dispatch.runningNoLimit', { running })
            : over
              ? tr('board.dispatch.runningOver', { running, cap: limit })
              : tr('board.dispatch.running', { running, cap: limit })}
      </RunningLine>
      {/* THE FLOOR HOLDS IN THIS MODE TOO, and it was said nowhere: "3 di 4"
          reads as a free slot while no agent can start. The capacity reading
          carries a verdict here only when the floor or a drain holds. */}
      {s.capacity?.admission && !s.capacity.admission.admit && (
        <p className="text-mini leading-snug"><Verdict admission={s.capacity.admission} /></p>
      )}
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

      {/* The scope and the "why this number" are true at every opening, but
          nobody reads them at every opening. */}
      <HowItWorks>
        <p>{tr('board.dispatch.oneMachine')}</p>
        {mode === 'auto' && s.capacity && <p>{s.capacity.reason}</p>}
        {mode === 'off' && <p>{tr('board.dispatch.noLimitHint')}</p>}
      </HowItWorks>
    </>
  );
}

/**
 * The other brake: ONE share of what this computer has free, a single live
 * line against it with its verdict, and the explanations folded away. The fixed
 * number is not drawn here because it does not apply.
 */
function ResourcesBrake() {
  const tr = useT();
  const s = useGlobalDispatchCap();
  const cap = s.capacity;
  const share = budgetShare(s.cap ?? {});
  // The share the slider is showing, draft included: what it buys, under
  // "How it works", moves under the finger with the label.
  const [shownShare, setShownShare] = useState<number | null>(null);
  const shown = shownShare ?? share;
  // The numbers the gate DECIDED ON (probe plus the turns still warming up),
  // not the bare probe: "2.0 of 6.6" in green beside "new ones wait" was the
  // two sides of the same line counting differently.
  const { used, usable, pending } = gateCoreNumbers(cap);
  // THE VERDICT IS THE GATE'S, read off the wire (`admission`), never worked
  // out here: `used >= usable` ignored the cost of the agent to admit, the 80%
  // resume line and the memory axis, and said "would start" while the gate
  // held. No admission on the wire (an old server) = no verdict drawn.
  const admission = cap?.admission ?? null;
  // Nothing usable is the red end, not "no threshold": the others hold it all.
  const liveBand: ThresholdBand | null = used == null ? null : usable <= 0 ? 'red' : livePressureBand(used, usable);
  const cores = cap?.cores ?? 0;

  return (
    <>
      <RunningLine className="text-app-text-heading">
        {s.cap ? tr('board.dispatch.runningResources', { running: cap?.running ?? 0 }) : tr('board.dispatch.runningLoading')}
      </RunningLine>

      <BudgetSlider share={share} onDraft={setShownShare} onCommit={(next) => { void saveGlobalCap({ budgetShare: next }); }} />

      {/* THE NUMBERS AND THE VERDICT, on one line. The verdict says the
          exemption out loud: a pass earned only because nobody is running yet
          is not a free machine, and the line must not claim it is. */}
      <p className="flex flex-wrap items-baseline gap-x-1.5 text-mini leading-snug tabular-nums">
        <span
          className={liveBand ? BAND_TEXT[liveBand] : 'text-app-text-faint'}
          data-testid="global-cap-budget-live"
          data-band={liveBand ?? 'none'}
        >
          {used == null || cores <= 0
            ? tr('board.dispatch.liveLoading')
            : pending > 0
              ? tr(pending === 1 ? 'board.dispatch.liveFreePendingOne' : 'board.dispatch.liveFreePending', { used: used.toFixed(1), usable: usable.toFixed(1), n: pending })
              : tr('board.dispatch.liveFree', { used: used.toFixed(1), usable: usable.toFixed(1) })}
        </span>
        {admission && (used != null || !admission.admit) && <Verdict admission={admission} />}
      </p>

      <HowItWorks>
        <p>{tr('board.dispatch.resourcesHint')}</p>
        {cores > 0 && (
          <p data-testid="global-cap-budget-units">
            {tr('board.dispatch.budgetHint', {
              cores,
              units: (cores * shown).toFixed(1),
              mem: Math.round((cap?.totalMemGB ?? 0) * shown),
            })}
          </p>
        )}
        <p>{tr('board.dispatch.oneMachine')}</p>
        {(cap?.frozen ?? 0) > 0 && <p>{tr('board.gauge.frozen', { n: cap?.frozen ?? 0 })}</p>}
      </HowItWorks>
    </>
  );
}

/**
 * THE ONE KNOB: a share of what the machine has free.
 *
 * WRITES ON RELEASE, NOT ON EVERY PIXEL. A drag fires an `input` event per
 * step; one PATCH each would be twenty writes and twenty broadcasts for one
 * gesture. While the pointer is down the value is a local draft; the write
 * happens on release. A change that arrives with no pointer down (arrow keys,
 * a test's `fill`) has no release to wait for and is written at once.
 */
function BudgetSlider({ share, onCommit, onDraft }: {
  share: number;
  onCommit: (share: number) => void;
  /** The draft while the pointer is down, `null` once it is written. */
  onDraft?: (share: number | null) => void;
}) {
  const tr = useT();
  const [draft, setDraftState] = useState<number | null>(null);
  const setDraft = (v: number | null) => { setDraftState(v); onDraft?.(v); };
  const dragging = useRef(false);
  const shown = draft ?? share;
  const commit = (v: number) => {
    setDraft(null);
    if (v !== share) onCommit(v);
  };
  const label = tr('board.dispatch.budgetOfFree', { pct: Math.round(shown * 100) });

  return (
    <div className="space-y-0.5 pt-1" data-testid="global-cap-budget">
      <div className="flex items-center justify-between gap-2 text-mini">
        <span className="text-app-text-muted">{tr('board.dispatch.budget')}</span>
        <span className="font-medium text-app-text-heading tabular-nums" data-testid="global-cap-budget-value">{label}</span>
      </div>
      <input
        type="range"
        data-testid="global-cap-budget-slider"
        aria-label={tr('board.dispatch.budget')}
        aria-valuetext={label}
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
    </div>
  );
}
