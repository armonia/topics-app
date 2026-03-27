import { WifiOff, RefreshCw, Loader2 } from 'lucide-react';
import type { ConnectionStatus as ConnectionStatusType } from '../../types';

interface ConnectionStatusProps {
  status: ConnectionStatusType;
  onRetry?: () => void;
  lastConnectedAt?: number | null;
}

export function ConnectionStatusBadge({ status }: ConnectionStatusProps) {
  const color = status === 'connected'
    ? 'bg-emerald-500'
    : status === 'connecting'
    ? 'bg-blue-500 animate-pulse'
    : status === 'reconnecting'
    ? 'bg-yellow-500 animate-pulse'
    : 'bg-red-500';

  const title = status === 'connected'
    ? 'Connected'
    : status === 'connecting'
    ? 'Connecting...'
    : status === 'reconnecting'
    ? 'Reconnecting...'
    : 'Offline';

  return (
    <div
      className={`w-1.5 h-1.5 rounded-full ${color} flex-shrink-0`}
      title={title}
      role="status"
      aria-label={`Connection status: ${title}`}
      data-testid="connection-status"
    />
  );
}

function formatTimeSince(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function ConnectionStatusBar({ status, onRetry, lastConnectedAt }: ConnectionStatusProps) {
  if (status === 'connected') return null;

  const isOffline = status === 'offline';
  const isConnecting = status === 'connecting';

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={`border-b px-4 py-2.5 flex items-center justify-center gap-3 ${
        isOffline
          ? 'bg-red-100 dark:bg-red-900/40 border-red-200 dark:border-red-800'
          : 'bg-amber-100 dark:bg-amber-900/40 border-amber-200 dark:border-amber-800'
      }`}
    >
      {isOffline ? (
        <WifiOff size={16} className="text-red-700 dark:text-red-400 flex-shrink-0" />
      ) : (
        <Loader2 size={16} className="text-amber-700 dark:text-amber-400 flex-shrink-0 animate-spin" />
      )}
      <div className="flex flex-col items-center gap-0.5">
        <span className={`text-[13px] font-medium ${
          isOffline
            ? 'text-red-800 dark:text-red-300'
            : 'text-amber-800 dark:text-amber-300'
        }`}>
          {isOffline
            ? 'Offline mode -- some features unavailable'
            : isConnecting
            ? 'Connecting to server...'
            : 'Reconnecting...'}
        </span>
        {isOffline && lastConnectedAt && (
          <span className="text-[11px] text-red-600 dark:text-red-400">
            Last connected: {formatTimeSince(lastConnectedAt)}
          </span>
        )}
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className={`ml-2 inline-flex items-center gap-1.5 px-3 py-1 text-[12px] font-medium rounded-md transition-colors cursor-pointer ${
            isOffline
              ? 'text-red-800 dark:text-red-300 bg-red-200/60 dark:bg-red-800/40 hover:bg-red-300/60 dark:hover:bg-red-700/40'
              : 'text-amber-800 dark:text-amber-300 bg-amber-200/60 dark:bg-amber-800/40 hover:bg-amber-300/60 dark:hover:bg-amber-700/40'
          }`}
        >
          <RefreshCw size={14} />
          Retry
        </button>
      )}
    </div>
  );
}
