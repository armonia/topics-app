/**
 * THE ROW THAT OPENS «ACCOUNT E QUOTE» (hub-smistamento, HUBBR-10), under the
 * plan in the menu with your name.
 *
 * It exists only where the usage hub is part of the installation: without it
 * there is nothing to open. Its tail says the hottest quota of a plan in use
 * once it reaches 80%, in amber, and otherwise how many plans the hub meters;
 * both read from the hub's live `pace`, so the menu asks nothing to open.
 */
import { Gauge } from 'lucide-react';
import { useHubEverRead, useHubLive } from '@/state/hubLive';
import { useMobile } from '@/hooks/useMobile';
import { useT } from '@/hooks/useT';
import { planCount } from '@/lib/accountQuotas';
import { highestQuota } from './hotQuota';
import { menuRowClass } from './menuRow';
import { SEGNALE_ATTESA } from './chromeSignals';

export function AccountQuotasRow({ onClose }: { onClose: () => void }) {
  const tr = useT();
  const { isMobile } = useMobile();
  const present = useHubEverRead();
  const pace = useHubLive().pace?.data;
  if (!present) return null;
  const hot = highestQuota(pace, tr);
  const n = planCount(pace);
  const count = n === 0 ? null : n === 1 ? tr('accounts.plansOne') : tr('accounts.plans', { n });
  return (
    <button
      type="button"
      className={menuRowClass(isMobile)}
      data-testid="menu-account-quotas"
      onClick={() => {
        onClose();
        window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'accounts' } }));
      }}
    >
      <Gauge size={14} className="flex-shrink-0 text-app-text-secondary" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-left">{tr('accounts.open')}</span>
      <span data-testid="menu-account-quotas-tail" data-warn={hot ? 'true' : undefined} className="max-w-[55%] flex-shrink-0 truncate text-mini tabular-nums text-app-text-tertiary" title={hot?.title}>
        {hot && <span className={SEGNALE_ATTESA}>{hot.text}</span>}
        {hot && count && ' · '}
        {count}
      </span>
    </button>
  );
}
