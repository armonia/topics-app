/**
 * THE CLAUDE PLAN AND HOW MUCH OF IT IS SPENT, in the «Abbonamento» line of
 * Claude Code's detail (model selector revision 2026-10-04, §5.5; USERMENU-10).
 *
 * They read together because they are one fact: «Max 20x, 42% of the window,
 * resets at 20:49». The plan comes from the providers snapshot (two labels the
 * server reads from the CLI, never the credential), the windows from the same
 * reading the plan-limit notice in the column uses. The selector keeps only a
 * short warning in the Anthropic heading.
 */
import { claudeSubscription, subscriptionLabel, usageLine, weekUsageLine } from '../Sidebar/formLevelTails';
import { SEGNALE_ATTESA } from '../Sidebar/chromeSignals';
import { PLAN_USAGE_WARN_AT } from '../../../../shared/provider-hold';
import { useProvidersSnapshot } from '@/hooks/useProvidersSnapshot';
import { usePlanUsage } from '@/state/planUsage';
import { useLocale, useT } from '@/hooks/useT';

export function ClaudePlanUsage() {
  const tr = useT();
  const locale = useLocale();
  const { snapshot } = useProvidersSnapshot();
  const usage = usePlanUsage();
  const plan = subscriptionLabel(claudeSubscription(snapshot));
  const fiveHour = usage?.fiveHour ?? null;
  const sevenDay = usage?.sevenDay ?? null;
  const line = usageLine(
    fiveHour,
    (ms) => new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false }),
    tr,
  );
  const weekLine = weekUsageLine(
    sevenDay,
    (ms) => new Date(ms).toLocaleString(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }),
    tr,
  );
  return (
    <div data-testid="providers-claude-plan" className="space-y-1.5">
      <div className="text-compact text-app-text">
        {plan ? tr('userMenu.subscription', { plan }) : tr('userMenu.subscriptionUnknown')}
      </div>
      {fiveHour || sevenDay ? (
        <>
          {fiveHour && <UsageBar window={fiveHour} line={line} testId="providers-claude-usage" />}
          {/* The week under the five hours (CMDUI-05): same bar, same colours. */}
          {sevenDay && <UsageBar window={sevenDay} line={weekLine} testId="providers-claude-week" />}
        </>
      ) : (
        <div data-testid="providers-claude-usage-none" className="text-mini text-app-text-secondary">{tr('userMenu.usage.none')}</div>
      )}
    </div>
  );
}

/** One window of the plan: a bar and its sentence, amber past the warning threshold. */
function UsageBar({ window, line, testId }: { window: { utilization: number }; line: string | null; testId: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(window.utilization)));
  const high = window.utilization >= PLAN_USAGE_WARN_AT;
  return (
    <>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={line ?? undefined}
        data-testid={`${testId}-bar`}
        data-warn={high ? 'true' : undefined}
        className="h-1 overflow-hidden rounded-full bg-app-border"
      >
        <div className={`h-full rounded-full ${high ? 'bg-amber-500' : 'bg-primary'}`} style={{ width: `${pct}%` }} />
      </div>
      <div data-testid={testId} data-warn={high ? 'true' : undefined} className={`text-mini tabular-nums ${high ? SEGNALE_ATTESA : 'text-app-text-secondary'}`}>
        {line}
      </div>
    </>
  );
}
