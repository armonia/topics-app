import { useState, useEffect, useCallback } from 'react';
import { Globe, ChevronDown, ChevronRight, Copy, Check, ExternalLink, RefreshCw, Power, PowerOff, Link2, Unlink } from 'lucide-react';

interface TunnelStatus {
  active: boolean;
  url?: string;
  type: 'tailscale' | 'cloudflare' | 'localtunnel' | 'ngrok' | 'unknown';
  expiresAt?: string;
  error?: string;
}

interface RemoteAccessPanelProps {
  expanded?: boolean;
}

export function RemoteAccessPanel({ expanded = false }: RemoteAccessPanelProps) {
  const [isExpanded, setIsExpanded] = useState(expanded);
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
    if (isExpanded) {
      fetchStatus();
      // Refresh every 30s
      const interval = setInterval(fetchStatus, 30000);
      return () => clearInterval(interval);
    }
  }, [isExpanded, fetchStatus]);

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
        // Refresh status after toggle
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
    <div className="border-t border-[#e8e8e8] dark:border-[#2a2a2a]">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[#f5f5f5] dark:hover:bg-[#252525] transition-colors"
      >
        {isExpanded ? <ChevronDown size={14} className="text-[#666] dark:text-[#999]" /> : <ChevronRight size={14} className="text-[#666] dark:text-[#999]" />}
        <Globe size={14} className={status?.active ? 'text-green-500' : 'text-[#888]'} />
        <span className="text-[13px] text-[#1a1a1a] dark:text-[#e5e5e5] flex-1">Remote Access</span>
        {status?.active && (
          <span className="text-[10px] text-green-500 bg-green-100 dark:bg-green-900/30 px-1.5 py-0.5 rounded">
            ONLINE
          </span>
        )}
        {loading && (
          <RefreshCw size={12} className="animate-spin text-[#888]" />
        )}
      </button>

      {/* Expanded content */}
      {isExpanded && (
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
                <div className="flex items-center gap-1 bg-white dark:bg-[#1a1a1a] rounded px-2 py-1.5 border border-green-200 dark:border-green-800">
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
              <div className="text-center py-3 text-[11px] text-[#888]">
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
            className="w-full flex items-center justify-center gap-1.5 px-2 py-1 text-[10px] text-[#888] hover:text-[#666] dark:hover:text-[#aaa] hover:bg-[#f0f0f0] dark:hover:bg-[#2a2a2a] rounded transition-colors"
          >
            <RefreshCw size={10} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      )}
    </div>
  );
}
