/**
 * THE AI PROVIDERS PANEL: the Claude plan and how much of it is spent, then the
 * providers form. It opens beside the model selector (SETHOME-01).
 *
 * The line on top answers what a person checks most often here: which Claude
 * subscription this machine is signed in with, and how full its five-hour
 * window is. They read together because they are one fact: «Max 20x, 42% of
 * the window, resets at 20:49». The plan comes from the providers snapshot
 * (two labels the server reads from the CLI, never the credential), the window
 * from the same reading the plan-limit notice in the column uses.
 */
import { AIProvidersSection } from '../Settings/AIProvidersSection';
import { claudeSubscription, subscriptionLabel, usageLine } from './formLevelTails';
import { SEGNALE_ATTESA } from './chromeSignals';
import { PLAN_USAGE_WARN_AT } from '../../../../shared/provider-hold';
import { useProvidersSnapshot } from '@/hooks/useProvidersSnapshot';
import { usePlanUsage } from '@/state/planUsage';
import { useLocale, useT } from '@/hooks/useT';

export function ProvidersLevelBody() {
  return (
    <div className="space-y-4">
      <ClaudePlanLine />
      <AIProvidersSection />
    </div>
  );
}

function ClaudePlanLine() {
  const tr = useT();
  const locale = useLocale();
  const { snapshot } = useProvidersSnapshot();
  const usage = usePlanUsage();
  const subscription = claudeSubscription(snapshot);
  const plan = subscriptionLabel(subscription);
  const fiveHour = usage?.fiveHour ?? null;
  // Only where there is a subscription to speak of: an API key or no login,
  // with no five-hour reading, has nothing to say here.
  if (!subscription && !fiveHour) return null;
  const line = usageLine(
    fiveHour,
    (ms) => new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false }),
    tr,
  );
  const pct = fiveHour ? Math.max(0, Math.min(100, Math.round(fiveHour.utilization))) : 0;
  const high = !!fiveHour && fiveHour.utilization >= PLAN_USAGE_WARN_AT;
  return (
    <div data-testid="providers-claude-plan" className="space-y-1.5 rounded-lg border border-app-border px-3 py-2.5">
      <div className="text-compact font-medium text-app-text">
        {plan ? tr('userMenu.subscription', { plan }) : tr('userMenu.subscriptionUnknown')}
      </div>
      {fiveHour ? (
        <>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-label={line ?? undefined}
            className="h-1 overflow-hidden rounded-full bg-app-border"
          >
            <div className={`h-full rounded-full ${high ? 'bg-amber-500' : 'bg-primary'}`} style={{ width: `${pct}%` }} />
          </div>
          <div data-testid="providers-claude-usage" className={`text-mini tabular-nums ${high ? SEGNALE_ATTESA : 'text-app-text-secondary'}`}>
            {line}
          </div>
        </>
      ) : (
        <div className="text-mini text-app-text-tertiary">{tr('userMenu.usage.none')}</div>
      )}
    </div>
  );
}
