import { useState } from 'react';
import { Wifi, Server, RefreshCw, Clock, RotateCcw, MessageSquare } from 'lucide-react';
import { useSystemStatus } from '../../hooks/useSystemStatus';
import { useOpenClawAvailable } from '../../hooks/useOpenClawAvailable';
import { openclawControlApi } from '../../lib/api';

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
  const [confirmingRestart, setConfirmingRestart] = useState(false);

  const gatewayOnline = status?.gateway.online ?? false;

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
          onClick={refresh}
          disabled={loading}
          className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-[11px] text-app-text-muted hover:text-app-text-secondary hover:bg-app-hover rounded transition-colors"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          {status?.gateway.lastCheckedAt
            ? formatTimeAgo(status.gateway.lastCheckedAt)
            : 'Refresh'}
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
              try {
                await openclawControlApi.restart();
                setTimeout(refresh, 3000);
              } catch {}
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

function formatTimeAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
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
