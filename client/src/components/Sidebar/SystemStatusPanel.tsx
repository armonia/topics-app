import { useState } from 'react';
import { Wifi, Server, HardDrive, RefreshCw, Clock, RotateCcw } from 'lucide-react';
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
    <div className="pb-2 px-2">
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

          {/* Memory */}
          <StatusRow
            icon={<HardDrive size={12} />}
            label="Memory"
            value={`${status.server.memoryMB} MB`}
            detail={`heap: ${status.server.heapUsedMB}/${status.server.heapTotalMB} MB`}
            color={status.server.memoryMB > 512 ? 'yellow' : 'green'}
          />

          {/* Cron Jobs — OpenClaw only */}
          {openclawAvailable && (
            <StatusRow
              icon={<Clock size={12} />}
              label="Cron Jobs"
              value={`${status.cronJobs.enabled}/${status.cronJobs.total}`}
              detail={status.cronJobs.nextRun ? `next: ${formatTimeAgo(status.cronJobs.nextRun)}` : 'enabled'}
              color={status.cronJobs.total === 0 ? 'yellow' : 'green'}
            />
          )}

          {/* Connections */}
          <div className="flex items-center gap-3 px-2 py-1.5 rounded bg-elevated">
            <div className="flex-1 flex items-center gap-2" title="WebSocket — connessioni client attive">
              <span className="text-[10px] text-app-text-muted">WS</span>
              <span className="text-[11px] font-medium text-app-text">
                {status.connections.wsClients}
              </span>
            </div>
            <div className="flex-1 flex items-center gap-2" title="Streams — flussi dati in tempo reale attivi">
              <span className="text-[10px] text-app-text-muted">Streams</span>
              <span className={`text-[11px] font-medium ${
                status.connections.activeStreams > 0 ? 'text-primary' : 'text-app-text'
              }`}>
                {status.connections.activeStreams}
              </span>
            </div>
            <div className="flex-1 flex items-center gap-2" title="Topics — argomenti attualmente attivi">
              <span className="text-[10px] text-app-text-muted">Topics</span>
              <span className="text-[11px] font-medium text-app-text">
                {status.topics.activeCount}
              </span>
            </div>
          </div>
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
    <div className="flex items-center gap-1.5 px-2 py-1.5 rounded hover:bg-app-hover">
      <span className={`w-1.5 h-1.5 rounded-full ${dotColor} flex-shrink-0`} />
      <span className="text-app-text-muted flex-shrink-0">{icon}</span>
      <span className="text-[11px] text-app-text-muted flex-shrink-0">{label}</span>
      <span className="text-[11px] font-medium text-app-text flex-1 text-right">
        {value}
      </span>
      {detail && (
        <span className="text-[10px] text-app-text-muted flex-shrink-0">{detail}</span>
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
