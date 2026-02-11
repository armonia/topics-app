import { WifiOff, RefreshCw } from 'lucide-react';
import type { ConnectionStatus as ConnectionStatusType } from '../../types';

interface ConnectionStatusProps {
  status: ConnectionStatusType;
  onRetry?: () => void;
}

export function ConnectionStatusBadge({ status }: ConnectionStatusProps) {
  const color = status === 'connected'
    ? 'bg-emerald-500'
    : status === 'reconnecting'
    ? 'bg-yellow-500 animate-pulse'
    : 'bg-red-500';

  const title = status === 'connected'
    ? 'Connected'
    : status === 'reconnecting'
    ? 'Reconnecting...'
    : 'Offline';

  return (
    <div
      className={`w-1.5 h-1.5 rounded-full ${color} flex-shrink-0`}
      title={title}
    />
  );
}

export function ConnectionStatusBar({ status, onRetry }: ConnectionStatusProps) {
  if (status === 'connected') return null;

  return (
    <div className="bg-amber-100 dark:bg-amber-900/40 border-b border-amber-200 dark:border-amber-800 px-4 py-2.5 flex items-center justify-center gap-3">
      <WifiOff size={18} className="text-amber-700 dark:text-amber-400 flex-shrink-0" />
      <span className="text-[13px] font-medium text-amber-800 dark:text-amber-300">
        Working offline — some features unavailable
      </span>
      {onRetry && (
        <button
          onClick={onRetry}
          className="ml-2 inline-flex items-center gap-1.5 px-3 py-1 text-[12px] font-medium text-amber-800 dark:text-amber-300 bg-amber-200/60 dark:bg-amber-800/40 hover:bg-amber-300/60 dark:hover:bg-amber-700/40 rounded-md transition-colors cursor-pointer"
        >
          <RefreshCw size={13} />
          Retry
        </button>
      )}
    </div>
  );
}
