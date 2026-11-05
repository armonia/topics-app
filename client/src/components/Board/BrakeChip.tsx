/**
 * THE «FRENATO» CHIP IN THE BOARD'S BAR (HUBBR-20).
 *
 * Present only while Topics keeps a provider's cards in Todo: Claude or Codex
 * at the wall of their plan, or Claude's five-hour window past the dispatch
 * line. It names the provider, the quota and when the cards start again; the
 * popover lists both providers, held or free. The hub's own pace brake does
 * not hold cards and lives in «Account e quote», which the popover links to
 * where the hub answers. There is no «release» here: nothing in Topics lifts a
 * spent window.
 */
import { useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronDown, CirclePause } from 'lucide-react';
import { useLocale, useT } from '../../hooks/useT';
import { addCatalogue } from '../../lib/i18n';
import BRAKES_IT from '../../lib/i18n-brakes-it';
import BRAKES_EN from '../../lib/i18n-brakes-en';
import { SUCCESS_TEXT, WARNING_TEXT } from '../../lib/popoverStyles';
import { useDispatchBrakes } from '../../state/dispatchBrakes';
import { useHubEverRead } from '../../state/hubLive';
import { providerHoldLabel, type DispatchBrake } from '../../../../shared/provider-hold';
import { Menu } from '../Shared/Menu';
import { brakeChipView, brakeDetail } from './brakeText';
import { TOOLBAR_CONTROL_H } from './constants';

addCatalogue('it', BRAKES_IT);
addCatalogue('en', BRAKES_EN);

const PROVIDERS: readonly DispatchBrake['provider'][] = ['claude', 'codex'];

/**
 * `band`: the phone's form, a full-width row under the bar, where the bar is a
 * strip that scrolls sideways and a chip at its end would be out of sight.
 */
export function BrakeChip({ band = false }: { band?: boolean } = {}) {
  const tr = useT();
  const locale = useLocale();
  const brakes = useDispatchBrakes();
  const hub = useHubEverRead();
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const now = Date.now();
  const view = brakeChipView(brakes, now, tr, locale);
  if (!view) return null;
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
          const b = brakes.find((x) => x.provider === p) ?? null;
          return (
            <div
              key={p}
              data-testid={`board-brake-row-${p}`}
              data-held={b ? 'true' : 'false'}
              className={`grid grid-cols-[14px_1fr_auto] items-center gap-x-2 gap-y-0.5 border-t border-app-border px-3 py-2 ${b ? 'bg-amber-500/[0.08] dark:bg-amber-400/[0.07]' : ''}`}
            >
              {b ? <CirclePause className={`h-3 w-3 ${WARNING_TEXT}`} aria-hidden="true" /> : <Check className={`h-3 w-3 ${SUCCESS_TEXT}`} aria-hidden="true" />}
              <span className="text-compact font-medium text-app-text">{providerHoldLabel(p)}</span>
              <span className={`text-mini ${b ? `font-semibold ${WARNING_TEXT}` : SUCCESS_TEXT}`}>{b ? tr('brake.pop.held') : tr('brake.pop.free')}</span>
              <span className="col-start-2 col-end-4 text-mini leading-snug text-app-text-muted">
                {b ? brakeDetail(b, now, tr, locale) : tr('brake.pop.freeDetail')}
              </span>
              {b?.utilization != null && (
                <span className="col-start-2 col-end-4 mt-0.5 block h-1 overflow-hidden rounded-full bg-app-border">
                  <span className="block h-full rounded-full bg-amber-500" style={{ width: `${Math.min(100, Math.round(b.utilization))}%` }} />
                </span>
              )}
            </div>
          );
        })}
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
