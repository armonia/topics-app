import { useState, useEffect } from 'react';
import { AlertTriangle, Clock, DollarSign, Layers, MessageSquare, RefreshCw, RotateCcw, Server, Wifi } from 'lucide-react';
import { useSystemStatus } from '../../hooks/useSystemStatus';
import { useOpenClawAvailable } from '../../hooks/useOpenClawAvailable';
import { openclawControlApi } from '../../lib/api';
import { usePaneStore } from '../../state/pane/store';

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMins = minutes % 60;
  if (hours < 24) return `${hours}h ${remainMins}m`;
  const days = Math.floor(hours / 24);
  const remainHours = hours % 24;
  return `${days}d ${remainHours}h`;
}

function formatLatency(ms: number): string {
  if (ms < 1) return '<1ms';
  return `${ms}ms`;
}

interface SystemStatusPanelProps {
  enabled?: boolean;
}

export function SystemStatusPanel({ enabled = true }: SystemStatusPanelProps) {
  const { status, loading, error, refresh } = useSystemStatus(enabled, 30000);
  const openclawAvailable = useOpenClawAvailable();
  const [restarting, setRestarting] = useState(false);
  /** Il motivo dell'ultimo riavvio fallito. `null` = non e' fallito niente. */
  const [erroreRiavvio, setErroreRiavvio] = useState<string | null>(null);
  const [confirmingRestart, setConfirmingRestart] = useState(false);
  // Local spinner state for the manual refresh: useSystemStatus's `loading` only
  // flips on the initial fetch, not on a manual re-poll, so the icon never spun
  // on click. A 500ms floor makes the (fast) refresh visibly acknowledged.
  const [refreshing, setRefreshing] = useState(false);
  const doRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await Promise.all([refresh(), new Promise(r => setTimeout(r, 500))]);
    } finally {
      setRefreshing(false);
    }
  };

  // "Aggiornato X fa" — the real last-fetch time. Every status update (manual
  // refresh OR the 30s auto-poll) lands a new object, so this resets then. A 1s
  // ticker re-renders so the counter actually counts up live (it was frozen).
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  useEffect(() => { if (status) setLastRefreshedAt(Date.now()); }, [status]);
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const gatewayOnline = status?.gateway.online ?? false;

  // ALL open tabs (panes) right now — chat, terminal, browser, editor, file…
  // not just chat (the old "Tab aperti" counted chat-only and under-reported).
  const openTabs = usePaneStore(s => Object.keys(s.panes).length);

  return (
    // pt-2: breathing room so the first row isn't squashed against the
    // PerfSection separator (border-b) directly above this panel.
    <div className="pt-2 pb-2 px-2">
      {error && !status && (
        <div className="px-2 py-1 text-[11px] text-red-500">{error}</div>
      )}

      {status && (
        <div className="space-y-1">
          {/* Gateway — OpenClaw only */}
          {openclawAvailable && (
            <StatusRow
              icon={<Wifi size={12} />}
              label="Gateway"
              value={formatGatewayStatus(status.gateway.status)}
              detail={gatewayOnline ? formatLatency(status.gateway.latencyMs) : undefined}
              color={gatewayOnline ? 'green' : status.gateway.status === 'timeout' ? 'yellow' : 'red'}
            />
          )}

          {/* Server */}
          <StatusRow
            icon={<Server size={12} />}
            label="Server"
            value={formatUptime(status.server.uptimeMs)}
            detail="uptime"
            color="green"
          />

          {/* Memory lives in the PerfSection block above (full per-process
              breakdown + server RSS) — not repeated here. */}

          {/* Modelli senza prezzo. Compare SOLO quando ce n'e' uno: e' un
              avviso, non un contatore, e uno «0» permanente sarebbe rumore che
              si impara a ignorare. I turni di quei modelli vengono contati a
              costo zero — indistinguibile da «gratis» — quindi il totale della
              spesa e' in difetto finche' la riga resta. */}
          {(status.server.unpricedModels?.length ?? 0) > 0 && (
            <StatusRow
              icon={<DollarSign size={12} />}
              label="Modelli senza prezzo"
              value={`${status.server.unpricedModels!.length}`}
              detail={status.server.unpricedModels!.join(', ')}
              color="yellow"
            />
          )}

          {/* Cron Jobs — OpenClaw only */}
          {openclawAvailable && (
            <StatusRow
              icon={<Clock size={12} />}
              label="Cron Jobs"
              value={`${status.cronJobs.enabled}/${status.cronJobs.total}`}
              detail="attivi"
              color={status.cronJobs.total === 0 ? 'yellow' : 'green'}
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
            label="Tab aperti"
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

      {/* Action buttons */}
      <div className="flex gap-1 mt-1">
        <button
          onClick={doRefresh}
          disabled={refreshing || loading}
          className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-[11px] text-app-text-muted hover:text-app-text-secondary hover:bg-app-hover rounded transition-colors"
        >
          <RefreshCw size={12} className={refreshing || loading ? 'animate-spin' : ''} />
          {refreshing
            ? 'Aggiorno…'
            : lastRefreshedAt !== null
              ? `aggiornato ${formatAgo(lastRefreshedAt)}`
              : 'Aggiorna'}
        </button>
        {openclawAvailable && (
          <button
            onClick={async () => {
              if (!confirmingRestart) {
                setConfirmingRestart(true);
                setTimeout(() => setConfirmingRestart(false), 3000);
                return;
              }
              setConfirmingRestart(false);
              setRestarting(true);
              // STESSO DIFETTO DELLA «Ricarica» DI UNA TAB TERMINALE, e stessa
              // cura: il `catch {}` vuoto ingoiava ogni rifiuto, e il bottone
              // tornava da «Riavvio…» a «Riavvia» come se fosse andata bene.
              // Chi guarda non ha modo di distinguere un riavvio riuscito da
              // uno che non e' mai partito — e la mossa successiva delle due e'
              // opposta: aspettare, oppure andare a vedere perche'.
              try {
                await openclawControlApi.restart();
                setTimeout(refresh, 3000);
              } catch (e) {
                setErroreRiavvio(e instanceof Error ? e.message : 'Riavvio non riuscito');
              }
              setRestarting(false);
            }}
            disabled={restarting}
            className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-[11px] rounded transition-colors whitespace-nowrap ${
              confirmingRestart
                ? 'text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20'
                : 'text-amber-400 hover:text-amber-300 hover:bg-app-hover'
            }`}
          >
            <RotateCcw size={12} className={restarting ? 'animate-spin' : ''} />
            {restarting ? 'Riavvio…' : confirmingRestart ? 'Sei sicuro?' : 'Riavvia'}
          </button>
        )}
      </div>
      {/* Un riavvio fallito ha una RIGA, non un silenzio. Sta qui e non in un
          toast perche' questo pannello vive nella colonna: il toast lo
          coprirebbe la colonna stessa, e comunque il fatto va letto ACCANTO al
          bottone che lo ha prodotto. */}
      {erroreRiavvio && (
        <div
          data-testid="system-restart-error"
          className="mt-1.5 flex items-start gap-1.5 rounded bg-red-500/10 px-2 py-1 text-[11px] text-red-400"
        >
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{erroreRiavvio}</span>
        </div>
      )}
    </div>
  );
}

interface StatusRowProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail?: string;
  color: 'green' | 'yellow' | 'red';
}

function StatusRow({ icon, label, value, detail, color }: StatusRowProps) {
  const dotColor = color === 'green' ? 'bg-emerald-500' : color === 'yellow' ? 'bg-amber-500' : 'bg-red-500';

  return (
    // No hover highlight: these rows are read-only status, not clickable — a
    // hover bg made them look interactive when they do nothing.
    <div className="flex items-center gap-1.5 px-2 py-1.5 rounded">
      <span className={`w-1.5 h-1.5 rounded-full ${dotColor} flex-shrink-0`} />
      <span className="text-app-text-muted flex-shrink-0">{icon}</span>
      <span className="text-[11px] text-app-text-muted flex-shrink-0">{label}</span>
      <span className="text-[11px] font-medium text-app-text flex-1 text-right">
        {value}
      </span>
      {detail && (
        <span className="text-[11px] text-app-text-muted flex-shrink-0">{detail}</span>
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

function formatGatewayStatus(status: string): string {
  switch (status) {
    case 'online': return 'Online';
    case 'timeout': return 'Timeout';
    case 'connection_refused': return 'Refused';
    case 'server_error': return 'Server Error';
    case 'auth_error': return 'Auth Error';
    default: return 'Offline';
  }
}
