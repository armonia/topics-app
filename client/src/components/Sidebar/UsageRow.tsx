/**
 * THE ROW THAT OPENS «CONSUMI», the Dashboard (hub-smistamento, HUBBR-12),
 * under «Account e quote» in the menu with your name.
 *
 * Always there: the Dashboard and the usage per project exist without the hub
 * too. Where the hub is, its tail says today's Claude tokens and their list
 * price in euro, read once when the menu opens from the server's sum (cached a
 * minute there, a few kilobytes here).
 */
import { useEffect, useState } from 'react';
import { BarChart3, ChevronRight } from 'lucide-react';
import { apiFetch } from '@/lib/shell/net';
import { useHubEverRead } from '@/state/hubLive';
import { useMobile } from '@/hooks/useMobile';
import { useLocale, useT } from '@/hooks/useT';
import { menuRowClass } from './menuRow';

/** Today's tokens and list price as the tail says them; null when the proxy did not answer. */
function todayTail(usage: unknown, settings: unknown, locale: string, tr: ReturnType<typeof useT>): string | null {
  const totals = (usage as { totals?: { tokens?: unknown; listUsd?: unknown } } | null)?.totals;
  if (!totals || typeof totals.tokens !== 'number' || typeof totals.listUsd !== 'number') return null;
  const rate = (settings as { usdEur?: unknown } | null)?.usdEur;
  const exchangeRate = typeof rate === 'number' && rate > 0 ? rate : 0.92;
  const displayLocale = locale === 'it' ? 'it-IT' : 'en-US';
  // «4,2 M», as the Dashboard writes it: Intl's compact form says «Mln» in Italian.
  const n = totals.tokens;
  const tokens = n >= 1e6 ? `${(n / 1e6).toLocaleString(displayLocale, { maximumFractionDigits: n >= 1e8 ? 0 : 1 })} M` : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(Math.round(n));
  const amount = new Intl.NumberFormat(displayLocale, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(totals.listUsd * exchangeRate);
  return tr('usage.todayTail', { tokens, eur: amount });
}

export function UsageRow({ onClose }: { onClose: () => void }) {
  const tr = useT();
  const locale = useLocale();
  const { isMobile } = useMobile();
  const present = useHubEverRead();
  const [reads, setReads] = useState<{ usage: unknown; settings: unknown } | null>(null);
  useEffect(() => {
    if (!present) return;
    let alive = true;
    const read = (path: string) => apiFetch(path).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    void Promise.all([read('/api/hub-usage?days=1'), read('/api/switchboard/settings')])
      .then(([usage, settings]: unknown[]) => { if (alive) setReads({ usage, settings }); });
    return () => { alive = false; };
  }, [present]);
  const tail = present && reads ? todayTail(reads.usage, reads.settings, locale, tr) : null;
  return (
    <button
      type="button"
      className={menuRowClass(isMobile)}
      data-testid="menu-usage"
      onClick={() => {
        onClose();
        window.dispatchEvent(new CustomEvent('topics:open-utility', { detail: { type: 'dashboard' } }));
      }}
    >
      <BarChart3 size={14} className="flex-shrink-0 text-app-text-secondary" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-left">{tr('usage.open')}</span>
      {tail && (
        <span data-testid="menu-usage-tail" className={`max-w-[55%] flex-shrink-0 truncate tabular-nums text-app-text-tertiary ${isMobile ? 'text-compact' : 'text-mini coarse:text-compact'}`}>
          {tail}
        </span>
      )}
      <ChevronRight size={14} className="flex-shrink-0 text-app-text-tertiary" aria-hidden="true" />
    </button>
  );
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
