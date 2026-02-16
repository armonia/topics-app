import { useState, useEffect, useCallback } from 'react';
import { Copy, Check, ExternalLink, RefreshCw, Power, PowerOff, Link2, Unlink } from 'lucide-react';

interface TunnelStatus {
  active: boolean;
  url?: string;
  type: 'tailscale' | 'cloudflare' | 'localtunnel' | 'ngrok' | 'unknown';
  expiresAt?: string;
  error?: string;
}

interface RemoteAccessPanelProps {
  enabled?: boolean;
}

export function RemoteAccessPanel({ enabled = true }: RemoteAccessPanelProps) {
  const [status, setStatus] = useState<TunnelStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch('/api/remote/status');
      if (resp.ok) {
        const data = await resp.json();
        setStatus(data);
      }
    } catch (err) {
      console.error('[RemoteAccess] Failed to fetch status:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    fetchStatus();
    const interval = setInterval(fetchStatus, 30000);
    return () => clearInterval(interval);
  }, [enabled, fetchStatus]);

  const copyUrl = useCallback(() => {
    if (status?.url) {
      navigator.clipboard.writeText(status.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [status?.url]);

  const toggleTunnel = useCallback(async () => {
    setActionLoading(true);
    try {
      const action = status?.active ? 'stop' : 'start';
      const resp = await fetch('/api/remote/tunnel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (resp.ok) {
        setTimeout(fetchStatus, 1000);
      }
    } catch (err) {
      console.error('[RemoteAccess] Toggle failed:', err);
    } finally {
      setActionLoading(false);
    }
  }, [status?.active, fetchStatus]);

  const getTypeLabel = (type: string) => {
    switch (type) {
      case 'tailscale': return 'Tailscale Funnel';
      case 'cloudflare': return 'Cloudflare Tunnel';
      case 'localtunnel': return 'LocalTunnel';
      case 'ngrok': return 'ngrok';
      default: return 'Tunnel';
    }
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'tailscale': return 'text-blue-500';
      case 'cloudflare': return 'text-orange-500';
      case 'ngrok': return 'text-purple-500';
      default: return 'text-green-500';
    }
  };

  return (
    <div className="pb-3 px-3 space-y-2">
      {status?.active && status.url ? (
        <>
          {/* Active tunnel info */}
          <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-2">
            <div className="flex items-center gap-2 mb-1">
              <Link2 size={12} className="text-green-500" />
              <span className={`text-[10px] font-medium ${getTypeColor(status.type)}`}>
                {getTypeLabel(status.type)}
              </span>
            </div>

            {/* URL display */}
            <div className="flex items-center gap-1 bg-surface rounded px-2 py-1.5 border border-green-200 dark:border-green-800">
              <span className="text-[11px] text-green-700 dark:text-green-300 truncate flex-1 font-mono">
                {status.url}
              </span>
              <button
                onClick={copyUrl}
                className="p-1 hover:bg-green-100 dark:hover:bg-green-900/50 rounded transition-colors"
                title="Copy URL"
              >
                {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} className="text-green-500" />}
              </button>
              <a
                href={status.url}
                target="_blank"
                rel="noopener noreferrer"
                className="p-1 hover:bg-green-100 dark:hover:bg-green-900/50 rounded transition-colors"
                title="Open in browser"
              >
                <ExternalLink size={12} className="text-green-500" />
              </a>
            </div>

            {status.expiresAt && (
              <div className="text-[9px] text-green-600 dark:text-green-400 mt-1">
                Expires: {new Date(status.expiresAt).toLocaleString('en-US')}
              </div>
            )}
          </div>

          {/* Stop button */}
          <button
            onClick={toggleTunnel}
            disabled={actionLoading}
            className="w-full flex items-center justify-center gap-2 px-3 py-1.5 text-[11px] text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/30 rounded transition-colors disabled:opacity-50"
          >
            {actionLoading ? (
              <RefreshCw size={12} className="animate-spin" />
            ) : (
              <PowerOff size={12} />
            )}
            Disable Tunnel
          </button>
        </>
      ) : (
        <>
          {/* No active tunnel */}
          <div className="text-center py-3 text-[11px] text-app-text-muted">
            <Unlink size={20} className="mx-auto mb-2 opacity-50" />
            No active tunnel
          </div>

          {/* Start button */}
          <button
            onClick={toggleTunnel}
            disabled={actionLoading}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-[11px] text-white bg-blue-500 hover:bg-blue-600 rounded transition-colors disabled:opacity-50"
          >
            {actionLoading ? (
              <RefreshCw size={12} className="animate-spin" />
            ) : (
              <Power size={12} />
            )}
            Enable Tailscale Funnel
          </button>

          {status?.error && (
            <div className="text-[10px] text-red-500 bg-red-50 dark:bg-red-900/20 rounded p-2">
              {status.error}
            </div>
          )}
        </>
      )}

      {/* Refresh button */}
      <button
        onClick={fetchStatus}
        disabled={loading}
        className="w-full flex items-center justify-center gap-1.5 px-2 py-1 text-[10px] text-app-text-muted hover:text-app-text-secondary hover:bg-app-hover rounded transition-colors"
      >
        <RefreshCw size={10} className={loading ? 'animate-spin' : ''} />
        Refresh
      </button>
    </div>
  );
}
