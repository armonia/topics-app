/**
 * THE ROW THAT OPENS «ACCOUNT E QUOTE» (hub-smistamento, HUBBR-10), under the
 * plan in the menu with your name.
 *
 * It exists only where the usage hub is part of the installation: without it
 * there is nothing to open. Its tail says the hottest quota of a plan in use
 * once it reaches 80%, in amber, then how many accounts the view lists: the
 * proxy's Claude accounts, read once when the menu opens, plus the providers
 * the hub meters, counted by the same `accountCount` as the view's header.
 */
import { useEffect, useState } from 'react';
import { ChevronRight, Gauge } from 'lucide-react';
import { apiFetch } from '@/lib/shell/net';
import { useHubEverRead, useHubLive } from '@/state/hubLive';
import { useMobile } from '@/hooks/useMobile';
import { useT } from '@/hooks/useT';
import { accountCount } from '@/lib/accountQuotas';
import { highestQuota } from './hotQuota';
import { menuRowClass } from './menuRow';
import { SEGNALE_ATTESA } from './chromeSignals';

export function AccountQuotasRow({ onClose }: { onClose: () => void }) {
  const tr = useT();
  const { isMobile } = useMobile();
  const present = useHubEverRead();
  const pace = useHubLive().pace?.data;
  // undefined while reading; null when the proxy did not answer (the view then lists no Claude card).
  const [profiles, setProfiles] = useState<unknown>(undefined);
  useEffect(() => {
    if (!present) return;
    let alive = true;
    apiFetch('/api/switchboard/profiles')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((v: unknown) => { if (alive) setProfiles(v); });
    return () => { alive = false; };
  }, [present]);
  if (!present) return null;
  const hot = highestQuota(pace, tr);
  const n = profiles === undefined ? 0 : accountCount(profiles, pace);
  const count = n === 0 ? null : n === 1 ? tr('accounts.countOne') : tr('accounts.count', { n });
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
      <span data-testid="menu-account-quotas-tail" data-warn={hot ? 'true' : undefined} className={`max-w-[55%] flex-shrink-0 truncate tabular-nums text-app-text-tertiary ${isMobile ? 'text-compact' : 'text-mini coarse:text-compact'}`} title={hot?.title}>
        {hot && <span className={SEGNALE_ATTESA}>{hot.text}</span>}
        {hot && count && ' · '}
        {count}
      </span>
      <ChevronRight size={14} className="flex-shrink-0 text-app-text-tertiary" aria-hidden="true" />
    </button>
  );
}
