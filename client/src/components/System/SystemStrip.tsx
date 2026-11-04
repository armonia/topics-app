/**
 * THE SYSTEM AT A GLANCE, at the foot of the sidebar (desktop) or above the
 * bottom row (phone): one sentence and a few numbers from the usage hub,
 * pushed live on the socket (state/hubLive.ts). A click opens the System pane
 * as a split cell beside the work (the sheet on the phone); it never replaces
 * the tab in front.
 *
 * Hidden while the hub was never readable, so an installation without the hub
 * shows nothing. Once read, a hub that stops answering says so in one quiet
 * line and drops the numbers: they stopped being true.
 */
import { ChevronRight, ChevronUp } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { useHubEverRead, useHubLive } from '../../state/hubLive';
import { openSystemPane, useSystemPaneOpen, useSystemSheetOpen } from '../../state/systemPane';
import { stripModel, type QuotaLine, type StripState } from '../../lib/hubSystem';
import { ROW_INSET } from '../../lib/selectionStyles';

const DOT: Record<Exclude<StripState, 'hidden'>, string> = {
  calm: 'bg-emerald-500',
  attention: 'bg-amber-500',
  partial: 'bg-amber-500',
  down: 'bg-app-text-faint',
};

const WARM = 'text-amber-700 dark:text-amber-300';

function Meter({ pct, hot }: { pct: number; hot: boolean }) {
  const width = Math.max(0, Math.min(100, pct));
  return (
    <span aria-hidden="true" className="relative inline-block h-[3px] w-4 shrink-0 overflow-hidden rounded-full bg-app-border-light">
      <span className={`absolute inset-y-0 left-0 rounded-full ${hot ? 'bg-amber-500' : 'bg-app-text-tertiary'}`} style={{ width: `${width}%` }} />
    </span>
  );
}

function Quota({ q }: { q: QuotaLine }) {
  const shown = q.fiveHour !== null && q.fiveHour > q.used ? q.fiveHour : q.used;
  return (
    <span className="inline-flex items-center gap-1" data-testid="system-strip-quota">
      {q.provider}
      {/* A meter only where the number is warm (cpu too): the line holds cpu,
          swap and two accounts in the sidebar's width without cutting one. */}
      {q.hot && <Meter pct={shown} hot />}
      <em className={`not-italic ${q.hot ? WARM : 'text-app-text-secondary'}`}>{shown}</em>
    </span>
  );
}

export function SystemStrip({ variant = 'sidebar' }: { variant?: 'sidebar' | 'phone' }) {
  const t = useT();
  const live = useHubLive();
  const everRead = useHubEverRead();
  const paneOpen = useSystemPaneOpen();
  const sheetOpen = useSystemSheetOpen();
  const open = variant === 'phone' ? sheetOpen : paneOpen;
  const model = stripModel(live, everRead);
  if (model.state === 'hidden') return null;

  const down = model.state === 'down';
  const sentence = down
    ? t('hubSystem.strip.hubDown')
    : t(model.state === 'calm' ? 'hubSystem.strip.calm' : model.state === 'partial' ? 'hubSystem.strip.partial' : 'hubSystem.strip.attention');
  const servicesLine = !down && model.servicesDown > 0
    ? t(model.servicesDown === 1 ? 'hubSystem.strip.servicesDown.one' : 'hubSystem.strip.servicesDown.other', { n: model.servicesDown })
    : null;
  const mac = model.mac;
  const Chevron = variant === 'phone' ? ChevronUp : ChevronRight;

  return (
    <button
      type="button"
      data-testid="system-strip"
      data-state={model.state}
      aria-expanded={open}
      aria-label={t('hubSystem.strip.open')}
      title={t('hubSystem.strip.open')}
      onClick={openSystemPane}
      className={`group relative block w-full text-left transition-colors hover:bg-app-hover ${open ? 'bg-app-hover' : ''} ${variant === 'sidebar' ? 'border-t border-app-border' : ''}`}
      style={{ paddingInline: variant === 'phone' ? 'max(12px, var(--sal))' : ROW_INSET + 6, paddingBlock: 7 }}
    >
      {open && <span aria-hidden="true" className="absolute bottom-2 left-0 top-2 w-0.5 rounded-r bg-primary" />}
      <span className="flex min-w-0 items-center gap-[7px] whitespace-nowrap text-compact text-app-text">
        <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[model.state]}`} />
        <b className={`font-semibold ${down ? 'font-medium text-app-text-secondary' : ''}`}>{sentence}</b>
        {servicesLine && <span className="truncate text-app-text-muted">· {servicesLine}</span>}
        <Chevron size={12} aria-hidden="true" className={`ml-auto shrink-0 ${open ? 'text-primary' : 'text-app-text-faint group-hover:text-app-text-secondary'}`} />
      </span>
      {!down && (mac || model.quotas.length > 0) && (
        <span data-testid="system-strip-numbers" className="mt-[5px] flex gap-2.5 overflow-hidden whitespace-nowrap font-mono text-[10.5px] tabular-nums text-app-text-muted">
          {mac?.cpu != null && (
            <span className="inline-flex items-center gap-1">
              {t('hubSystem.strip.cpu')}
              {mac.strained && <Meter pct={mac.cpu} hot />}
              <em className={`not-italic ${mac.strained ? WARM : 'text-app-text-secondary'}`}>{mac.cpu}</em>
            </span>
          )}
          {mac?.swapGB != null && (
            <span className="inline-flex items-center gap-1">
              {t('hubSystem.strip.swap')}
              <em className={`not-italic ${mac.swapHot ? WARM : 'text-app-text-secondary'}`}>{mac.swapGB.toFixed(1)}G</em>
            </span>
          )}
          {model.quotas.slice(0, 3).map((q) => <Quota key={q.key} q={q} />)}
        </span>
      )}
    </button>
  );
}
