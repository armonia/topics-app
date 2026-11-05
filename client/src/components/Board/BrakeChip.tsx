/**
 * THE «FRENATO» CHIP IN THE BOARD'S BAR (HUBBR-20), and the two marks the
 * same verdict leaves on the board: the strip at the top of the Todo column
 * and the line on each held card.
 *
 * Present only while Topics keeps at least one card in Todo behind a
 * provider's wall: Claude or Codex at the wall of their plan, or Claude's
 * five-hour window past the dispatch line. A wall that holds no card (every
 * card on Automatic found another runtime) is not named. The chip names the
 * provider, the quota and when the cards start again; the popover lists every
 * runtime with what it is doing (held cards, cards at work, the quota where it
 * is measured) and where the cards' heavy jobs run. The hub's own pace brake
 * does not hold cards and lives in «Account e quote», which the popover links
 * to where the hub answers. There is no «release» here: nothing in Topics
 * lifts a spent window.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, Check, ChevronDown, CirclePause, Monitor } from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import { addCatalogue } from '../../lib/i18n';
import BRAKES_IT from '../../lib/i18n-brakes-it';
import BRAKES_EN from '../../lib/i18n-brakes-en';
import { SUCCESS_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { meteredProviders } from '../../lib/accountQuotas';
import { useDispatchBrakes } from '../../state/dispatchBrakes';
import { useHubEverRead, useHubLive } from '../../state/hubLive';
import { providerHoldLabel, type DispatchBrake } from '../../../../shared/provider-hold';
import { Menu } from '../Shared/Menu';
import { brakeChipView, brakeDetail, columnNoteView, heldCount, holdingBrakes, waitingClause, workingClause } from './brakeText';
import { TOOLBAR_CONTROL_H } from './constants';

addCatalogue('it', BRAKES_IT);
addCatalogue('en', BRAKES_EN);

const PROVIDERS: readonly DispatchBrake['provider'][] = ['claude', 'codex'];
const HELD_SURFACE = 'bg-amber-500/[0.08] dark:bg-amber-400/[0.07]';

/** One row of the popover: glyph, name, state, a sentence, an optional bar. */
function Row({ id, held, glyph, name, state, stateTone, detail, pct }: {
  id: string; held: boolean; glyph: ReactNode; name: string; state: string; stateTone: string; detail: string; pct?: number | null;
}) {
  return (
    <div
      data-testid={`board-brake-row-${id}`}
      data-held={held ? 'true' : 'false'}
      className={`grid grid-cols-[14px_1fr_auto] items-center gap-x-2 gap-y-0.5 border-t border-app-border px-3 py-2 ${held ? HELD_SURFACE : ''}`}
    >
      {glyph}
      <span className="text-compact font-medium text-app-text">{name}</span>
      <span className={`text-mini ${stateTone}`}>{state}</span>
      <span className="col-start-2 col-end-4 text-mini leading-snug text-app-text-muted tabular-nums">{detail}</span>
      {pct != null && (
        <span className="col-start-2 col-end-4 mt-0.5 block h-1 overflow-hidden rounded-full bg-app-border">
          <span className={`block h-full rounded-full ${held ? 'bg-amber-500' : 'bg-app-text-muted/60'}`} style={{ width: `${Math.max(0, Math.min(100, Math.round(pct)))}%` }} />
        </span>
      )}
    </div>
  );
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * `band`: the phone's form, a full-width row under the bar, where the bar is a
 * strip that scrolls sideways and a chip at its end would be out of sight.
 */
export function BrakeChip({ band = false }: { band?: boolean } = {}) {
  const tr = useT();
  const locale = useLocale();
  const state = useDispatchBrakes();
  const hub = useHubEverRead();
  const live = useHubLive();
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const now = Date.now();
  const holding = holdingBrakes(state);
  const view = brakeChipView(holding, now, tr, locale);
  if (!view) return null;
  const metered = meteredProviders(live.pace?.data, live.gates?.data, now);
  const share = (p: string): number | null => (p === 'claude' ? state.claudeFiveHour : metered.find((m) => m.provider === p)?.fiveH ?? null);
  const muse = metered.find((m) => m.provider === 'muse') ?? null;
  const mac = isRecord(live.mac?.data) ? live.mac.data : null;
  const strained = mac?.strained === true;
  const load = typeof mac?.loadPerCore === 'number' ? mac.loadPerCore : null;
  const oneDecimal = (n: number) => n.toLocaleString(locale === 'en' ? 'en-GB' : 'it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const free = <Check className={`h-3 w-3 ${SUCCESS_TEXT}`} aria-hidden="true" />;
  const pause = <CirclePause className={`h-3 w-3 ${WARNING_TEXT}`} aria-hidden="true" />;
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        data-testid={band ? 'board-brake-band' : 'board-brake-chip'}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={tr('brake.title', { who: view.who })}
        onClick={() => setOpen((o) => !o)}
        className={`${band ? 'flex min-h-11 w-full items-start py-2.5 text-left text-compact leading-snug' : `flex ${TOOLBAR_CONTROL_H} items-center text-mini`} min-w-0 gap-1.5 rounded border border-amber-600/35 bg-amber-500/[0.14] px-2.5 dark:border-amber-400/30 dark:bg-amber-400/[0.12] ${WARNING_TEXT}`}
      >
        <CirclePause className={`h-3 w-3 shrink-0 ${band ? 'mt-0.5' : ''}`} aria-hidden="true" />
        <span className={band ? 'min-w-0 flex-1' : 'whitespace-nowrap'}>
          <b className="font-semibold">{tr('brake.chip')}</b>
          <span data-testid="board-brake-who"> · {view.who}</span>
          <span data-testid="board-brake-why" className="text-app-text opacity-85"> · {view.why}</span>
        </span>
        <ChevronDown className={`h-3 w-3 shrink-0 ${band ? 'mt-0.5' : ''}`} aria-hidden="true" />
      </button>
      <Menu open={open} anchorRef={btnRef} onClose={() => setOpen(false)} align="right" role="dialog" minWidth={340} maxWidth={380} testId="board-brake-pop" ariaLabel={tr('brake.pop.title')}>
        <div className="px-3 pb-2 pt-2.5">
          <p className="text-compact font-semibold text-app-text-heading">{tr('brake.pop.title')}</p>
          <p className="mt-0.5 text-mini leading-snug text-app-text-muted">{tr('brake.pop.lead', { who: view.who })}</p>
        </div>
        {PROVIDERS.map((p) => {
          const wall = state.brakes.find((x) => x.provider === p) ?? null;
          const working = workingClause(state.working[p] ?? 0, tr);
          if (wall) {
            const n = heldCount(state, p);
            const tail = n > 0 ? waitingClause(n, tr) : tr('brake.pop.noCard');
            return (
              <Row key={p} id={p} held={n > 0} glyph={pause} name={providerHoldLabel(p)} state={tr('brake.pop.held')} stateTone={`font-semibold ${WARNING_TEXT}`}
                detail={`${brakeDetail(wall, now, tr, locale)} · ${tail}`} pct={wall.utilization ?? share(p)} />
            );
          }
          const pct = share(p);
          const head = pct != null ? tr('brake.pop.share', { pct: Math.round(pct) }) : tr('brake.pop.freeDetail');
          return (
            <Row key={p} id={p} held={false} glyph={free} name={providerHoldLabel(p)} state={tr('brake.pop.free')} stateTone={SUCCESS_TEXT}
              detail={`${head} · ${working}`} pct={pct} />
          );
        })}
        {(muse || (state.working.muse ?? 0) > 0) && (
          <Row id="muse" held={false} glyph={free} name="Muse" state={tr('brake.pop.free')} stateTone={SUCCESS_TEXT}
            detail={`${tr('brake.pop.fixed')} · ${workingClause(state.working.muse ?? 0, tr)}`} />
        )}
        {mac && (
          <Row id="suite" held={false} glyph={<Monitor className="h-3 w-3 text-app-text-secondary" aria-hidden="true" />} name={tr('brake.suite.name')}
            state={strained ? tr('brake.suite.pc') : tr('brake.suite.mac')} stateTone="text-app-text-secondary"
            detail={strained ? (load != null ? tr('brake.suite.pcLoad', { load: oneDecimal(load) }) : tr('brake.suite.pcWhy')) : tr('brake.suite.macDetail')} />
        )}
        {hub && (
          <div className="border-t border-app-border px-3 py-2">
            <button
              type="button"
              data-testid="board-brake-accounts"
              onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'accounts' } })); }}
              className="inline-flex h-6 items-center gap-1 rounded border border-app-border px-2.5 text-mini text-app-text hover:bg-app-hover coarse:h-11"
            >
              {tr('brake.pop.accounts')}<ArrowUpRight className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>
        )}
      </Menu>
    </>
  );
}

/** The strip at the top of the Todo column: how many of THESE cards wait, for whom, until when. */
export function BrakeColumnNote({ todoIds }: { todoIds: readonly string[] }) {
  const tr = useT();
  const locale = useLocale();
  const state = useDispatchBrakes();
  const ids = useMemo(() => new Set(todoIds), [todoIds]);
  const view = columnNoteView(state, ids, Date.now(), tr, locale);
  if (!view) return null;
  return (
    <div data-testid="board-brake-column" className={`mx-2 mb-1.5 flex items-start gap-1.5 rounded px-2 py-1.5 text-mini leading-snug bg-amber-500/[0.14] dark:bg-amber-400/[0.12] ${WARNING_TEXT}`}>
      <CirclePause className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
      <div className="min-w-0"><b className="font-semibold">{view.head}</b><br /><span className="text-app-text-secondary">{view.tail}</span></div>
    </div>
  );
}

/** The line on a held card, in place of the queue's own chip: who holds it. */
export function BrakeCardLine({ taskId }: { taskId: string }) {
  const tr = useT();
  const state = useDispatchBrakes();
  const provider = state.held.get(taskId);
  if (!provider) return null;
  return (
    <div data-testid="board-brake-card" className={`flex items-center gap-1 text-mini font-medium ${WARNING_TEXT}`}>
      <CirclePause className="h-3 w-3 shrink-0" aria-hidden="true" />
      {tr('brake.card.wait', { who: providerHoldLabel(provider) })}
    </div>
  );
}

/** Whether the dispatcher holds this card behind a wall: the card then shows `BrakeCardLine`. */
export function useBrakeHeld(taskId: string): boolean {
  return useDispatchBrakes().held.has(taskId);
}
