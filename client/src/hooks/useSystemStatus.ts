import { useState, useEffect, useCallback } from 'react';

export type GatewayStatus = "online" | "offline" | "timeout" | "connection_refused" | "server_error" | "auth_error";

export interface SystemStatus {
  timestamp: string;
  gateway: {
    online: boolean;
    status: GatewayStatus;
    latencyMs: number;
    httpStatus?: number;
    lastCheckedAt: string | null;
  };
  server: {
    uptimeMs: number;
    startedAt: string;
    memoryMB: number;
    heapUsedMB: number;
    heapTotalMB: number;
  };
  connections: {
    wsClients: number;
    activeStreams: number;
    streamKeys: string[];
  };
  topics: {
    activeCount: number;
    totalCount: number;
  };
  cronJobs: {
    enabled: number;
    disabled: number;
    total: number;
    nextRun?: string;
  };
  sessions: {
    total: number;
    byType: Record<string, number>;
  };
  ports?: { port: number; pid: number; command: string }[];
}

export function useSystemStatus(enabled = true, intervalMs = 30000) {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/system/status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStatus(data);
      setError(null);
    } catch {
      setError('Failed to fetch status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let active = true;

    const poll = async () => {
      if (!active) return;
      await fetchStatus();
    };

    poll();
    const id = setInterval(poll, intervalMs);

    const onVisibility = () => {
      if (!document.hidden && active) poll();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      active = false;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, intervalMs, fetchStatus]);

  return { status, loading, error, refresh: fetchStatus };
}
