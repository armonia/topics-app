/**
 * WHAT IS LEFT OF «THIS COMPUTER»: facts of this installation, not of the
 * machine. Open tabs, archived chats, models with no price and the health of
 * the bridges. The server and the gateway are services of the machine's
 * Processes view now, Jarvis's jobs live in Automations, and nothing here
 * restarts anything: two views of the same machine, one with a restart button
 * the other lacks, was the mess this panel used to be.
 */
import { useState, useEffect } from 'react';
import { DollarSign, Layers, MessageSquare, RefreshCw } from 'lucide-react';
import { useSystemStatus } from '../../hooks/useSystemStatus';
import { useSystemHealth } from '../../hooks/useSystemHealth';
import { usePaneStore } from '../../state/pane/store';
import { startVisibleInterval } from '../../state/documentVisibility';
import { useLocale, useT } from '../../hooks/useT';

interface SystemStatusPanelProps {
  enabled?: boolean;
}

export function SystemStatusPanel({ enabled = true }: SystemStatusPanelProps) {
  const tr = useT();
  const locale = useLocale();
  const { status, loading, error, refresh } = useSystemStatus(enabled, 30000);
  const { health, error: healthError, refresh: refreshHealth } = useSystemHealth(enabled, 30000);
  // Local spinner state for the manual refresh: useSystemStatus's `loading` only
  // flips on the initial fetch, not on a manual re-poll, so the icon never spun
  // on click. A 500ms floor makes the (fast) refresh visibly acknowledged.
  const [refreshing, setRefreshing] = useState(false);
  const doRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await Promise.all([refresh(), refreshHealth(), new Promise(r => setTimeout(r, 500))]);
    } finally {
      setRefreshing(false);
    }
  };

  // "Aggiornato X fa" — the real last-fetch time.  allow-italian: quoted UI string
  // Every status update (manual refresh OR the 30s auto-poll) lands a new
  // object, so this resets then. A 1s ticker re-renders so the counter actually
  // counts up live (it was frozen).
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  useEffect(() => { if (status) setLastRefreshedAt(Date.now()); }, [status]);
  const [, setTick] = useState(0);
  useEffect(() => {
    return startVisibleInterval(() => setTick(t => t + 1), 1000);
  }, []);

  // ALL open tabs (panes) right now — chat, terminal, browser, editor, file…
  // not just chat (the old "Tab aperti" counted chat-only and under-reported).
  const openTabs = usePaneStore(s => Object.keys(s.panes).length);

  return (
    // pt-2: breathing room so the first row isn't squashed against the
    // PerfSection separator (border-b) directly above this panel.
    //
    // THE TESTID IS THE HANDLE, and it had to exist: the panel opens INSIDE the
    // «Topics» menu now, and the menu is itself a `.glass-surface` with the word
    // «Gateway» somewhere in it — the locator the suite used matched both, and a
    // strict locator that resolves to two elements fails on the day the panel
    // moves rather than on the day it breaks.
    <div data-testid="system-status-panel" className="pt-2 pb-2 px-2">
      {error && !status && (
        <div className="px-2 py-1 text-mini text-red-500">{error}</div>
      )}

      {status && (
        <div className="space-y-1">
          {/* Memory lives in the PerfSection block above (full per-process
              breakdown + server RSS) — not repeated here. */}

          {/* Models with no price. Shows up ONLY when there is one: it is a
              warning, not a counter, and a permanent «0» would be noise one
              learns to ignore. The turns of those models are counted at zero
              cost — indistinguishable from «free» — so the spend total is
              understated for as long as the row stays. */}
          {(status.server.unpricedModels?.length ?? 0) > 0 && (
            <StatusRow
              icon={<DollarSign size={12} />}
              label="Modelli senza prezzo"
              value={`${status.server.unpricedModels!.length}`}
              detail={status.server.unpricedModels!.join(', ')}
              color="yellow"
            />
          )}

          {/* Connections row removed: "WS" (server-wide socket count across all
              windows/devices) and "Tab aperti" (chat-only pane count) sat side by
              side looking related but measured unrelated things and contradicted
              each other — pure plumbing the user couldn't act on. */}

          {/* Open tabs — every pane kind (chat/terminal/browser/editor/file),
              the honest count (the old chat-only "Tab aperti" under-reported). */}
          <StatusRow
            icon={<Layers size={12} />}
            label={tr('systemHealth.openTabs')}
            value={`${openTabs}`}
            color={openTabs > 0 ? 'green' : 'yellow'}
          />

          {/* Topics archive size — a real feature stat, clearly labeled. */}
          <StatusRow
            icon={<MessageSquare size={12} />}
            label="Archiviati"
            value={`${status.topics.totalCount - status.topics.activeCount}`}
            detail={`${status.topics.totalCount} totali`}
            color="green"
          />
        </div>
      )}

      <section aria-label={tr('systemHealth.section')} data-testid="system-health-list" className="mt-2 border-t border-app-border pt-2">
        <div className="px-1 pb-1 text-mini font-medium text-app-text-muted">{tr('systemHealth.section')}</div>
        {healthError && !health && <div className="px-1 py-1 text-mini text-red-500">{healthError}</div>}
        {health?.subsystems.map((item) => {
          const dot = item.state === 'ok' ? 'bg-emerald-500' : item.state === 'warn' ? 'bg-amber-400' : item.state === 'error' ? 'bg-red-500' : 'bg-slate-400';
          const state = tr(`systemHealth.state.${item.state}`);
          return (
            <div key={item.id} data-testid={`system-health-${item.id}`} data-state={item.state} className="px-1 py-1 text-mini">
              <div className="flex items-center gap-1.5">
                <span aria-label={state} className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
                <span className="text-app-text-secondary">{tr(`systemHealth.name.${item.id}`)}</span>
                <span className="ml-auto text-app-text-muted">{state}</span>
              </div>
              <div className="pl-3 text-app-text-muted">{tr(`systemHealth.reason.${item.reason}`, item.params)}</div>
              {item.state !== 'ok' && <div className="pl-3 text-app-text-secondary">{tr(`systemHealth.action.${item.reason}`, item.params)}</div>}
              {item.lastError && <div className="pl-3 text-app-text-muted">{tr('systemHealth.lastError', { message: item.lastError.message, at: new Date(item.lastError.at).toLocaleString(locale) })}</div>}
            </div>
          );
        })}
      </section>

      {/* Action buttons */}
      <div className="flex gap-1 mt-1">
        <button
          data-testid="system-status-refresh"
          onClick={doRefresh}
          disabled={refreshing || loading}
          className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-mini text-app-text-muted hover:text-app-text-secondary hover:bg-app-hover rounded transition-colors"
        >
          <RefreshCw size={12} className={refreshing || loading ? 'animate-spin' : ''} />
          {refreshing
            ? 'Aggiorno…'
            : lastRefreshedAt !== null
              ? `aggiornato ${formatAgo(lastRefreshedAt)}`
              : 'Aggiorna'}
        </button>
      </div>
    </div>
  );
}

interface StatusRowProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail?: string;
  color: 'green' | 'yellow';
}

function StatusRow({ icon, label, value, detail, color }: StatusRowProps) {
  const dotColor = color === 'green' ? 'bg-emerald-500' : 'bg-amber-500';

  return (
    // No hover highlight: these rows are read-only status, not clickable — a
    // hover bg made them look interactive when they do nothing.
    <div className="flex items-center gap-1.5 px-2 py-1.5 rounded">
      <span className={`w-1.5 h-1.5 rounded-full ${dotColor} flex-shrink-0`} />
      <span className="text-app-text-muted flex-shrink-0">{icon}</span>
      <span className="text-mini text-app-text-muted flex-shrink-0">{label}</span>
      <span className="text-mini font-medium text-app-text flex-1 text-right">
        {value}
      </span>
      {detail && (
        <span className="text-mini text-app-text-muted flex-shrink-0">{detail}</span>
      )}
    </div>
  );
}

function formatAgo(ms: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 3) return 'ora';
  if (seconds < 60) return `${seconds}s fa`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m fa`;
  return `${Math.floor(minutes / 60)}h fa`;
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
