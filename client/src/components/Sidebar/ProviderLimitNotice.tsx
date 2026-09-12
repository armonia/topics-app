import { useRef, useState } from 'react';
import { ChevronRight, Clock3, Settings } from 'lucide-react';
import type { PlanUsageWindow, ProviderHold } from '../../../../shared/provider-hold';
import { PLAN_DISPATCH_HOLD_AT } from '../../../../shared/provider-hold';
import { useLocale, useT } from '../../hooks/useT';
import { useMobile } from '../../hooks/useMobile';
import { openSettings } from '../../lib/openSettings';
import { NO_DRAG_REGION } from '../../lib/shell/dragRegion';
import { Menu } from '../Shared/Menu';
import { SEGNALE_ATTESA } from './chromeSignals';

/** One compact explanation of the Claude account limit, with details on demand. */
export function ProviderLimitNotice({ hold, usage }: {
  hold: ProviderHold | null;
  usage: PlanUsageWindow | null;
}) {
  const tr = useT();
  const locale = useLocale();
  const { isMobile } = useMobile();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const until = hold?.untilMs ?? usage?.resetsAtMs;
  const waiting = !!hold || ((usage?.utilization ?? 0) >= PLAN_DISPATCH_HOLD_AT && usage?.resetsAtMs != null);
  const heading = hold ? tr('statusBar.providerHold.heading')
    : tr('statusBar.planUsage.heading', { pct: Math.round(usage?.utilization ?? 0) });
  // Always include the day: a weekly reset cannot be described by an hour alone.
  const date = until == null ? tr('statusBar.providerHold.unknownReset')
    : new Date(until).toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  const reset = tr('statusBar.providerHold.reset', { date });

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        {...NO_DRAG_REGION}
        data-testid={hold ? 'provider-hold-notice' : 'plan-usage-notice'}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="group flex w-full min-w-0 min-h-11 items-center gap-2 rounded-lg border border-app-border bg-app-hover/60 px-2.5 py-1.5 text-left hover:bg-app-hover focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
      >
        <Clock3 size={15} aria-hidden="true" className={`shrink-0 ${waiting ? SEGNALE_ATTESA : 'text-app-text-secondary'}`} />
        <span className="min-w-0 flex-1 leading-snug">
          <span className="block text-compact font-medium text-app-text">{heading}</span>
          <span className="block text-mini text-app-text-secondary">{reset}</span>
        </span>
        <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-app-text-secondary" />
      </button>
      <Menu
        open={open}
        anchorRef={anchorRef}
        onClose={() => setOpen(false)}
        side="right"
        minWidth={290}
        className={isMobile ? '' : 'w-80 max-w-[calc(100vw-16px)]'}
        testId="provider-limit-details"
        ariaLabel={heading}
      >
        <div className="space-y-2 px-3 py-2 text-compact leading-relaxed text-app-text">
          <p className="font-semibold">{heading}</p>
          <p>{tr(hold?.window === 'seven_day' ? 'statusBar.providerHold.week' : 'statusBar.providerHold.fiveHours')}</p>
          <p className="text-app-text-secondary">{reset}</p>
          <p className="text-app-text-secondary">{tr(waiting ? 'statusBar.providerHold.queuePaused' : 'statusBar.planUsage.remaining')}</p>
          <p className="text-app-text-secondary">{tr('statusBar.providerHold.otherChats')}</p>
        </div>
        <div className="border-t border-app-border px-1 pt-1">
          <button type="button" role="menuitem" onClick={() => { setOpen(false); openSettings('providers'); }} className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-compact text-app-text hover:bg-app-hover">
            <Settings size={14} aria-hidden="true" />{tr('statusBar.providerHold.manage')}
          </button>
        </div>
      </Menu>
    </>
  );
}
