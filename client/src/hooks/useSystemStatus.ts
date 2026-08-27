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
    /** Dev bundle hot-delivery active (topics-dev.json present): windows
     *  self-reload on each rebuild. Drives the quiet "auto-update" badge. */
    devReload?: boolean;
    /**
     * I modelli visti girare e NON presenti nella tabella prezzi del server.
     *
     * I loro turni vengono contati a costo ZERO, che e' indistinguibile da «non
     * e' costato niente»: e' la stessa forma di guasto che ha tenuto ogni Opus
     * tariffato al triplo per mesi senza che niente lo dicesse. Un modello nuovo
     * non e' un errore — ma deve VEDERSI, o il totale della spesa mente in
     * silenzio. Vuoto/assente = tutto tariffato.
     */
    unpricedModels?: string[];
    /**
     * The WHOLE server side: this process plus the detached sidecars (pty-bridge,
     * ai-bridge, WebRTC) and every process under them — the `claude` CLIs, MCP
     * servers and headless Chromes that hold most of Topics' RAM. `memoryMB`
     * above is the Bun process alone and is ~50x smaller.
     *
     * Summed from `ps rss`, NOT the phys_footprint the desktop shell reports:
     * the two are different metrics and are shown as separate lines, never
     * silently added into one. Absent where `ps` isn't usable (Windows).
     */
    fleet?: {
      processCount: number;
      memoryMB: number;
      /** Sum of `ps %cpu`; > 100 is normal on a multi-core box. */
      /** Scala 0-100 dell'INTERA macchina (già diviso per i core lato server),
       *  non la somma per-core di `ps`. Confrontabile con la CPU di sistema. */
      cpuPercent: number;
      /** Core logici su cui `cpuPercent` è normalizzato. */
      cpuCores: number;
      /** Da dove viene `memoryMB`: `footprint` è la metrica buona (la stessa
       *  della shell e di Monitoraggio Attività); `rss` è il ripiego e
       *  sovrastima le pagine condivise; `mixed` = copertura parziale. */
      memMetric: 'footprint' | 'rss' | 'mixed';
      roots: { kind: string; pid: number; processCount: number; memoryMB: number; cpuPercent: number }[];
      /** Ripartizione per SESSIONE dentro il pty-bridge: `roots` dice quanto
       *  tiene il bridge in tutto, questo quanto ne tiene ciascuna sessione.
       *  `cpuPercent: null` = non ancora misurata, che non è zero. */
      sessions: { sessionId: string; name: string; pid: number; processCount: number; memoryMB: number; cpuPercent: number | null }[];
      /** Memoria dei processi-script (lavoro degli agenti): esclusa dal totale
       *  server, mostrata come terzo asse dalla UI. */
      scriptsMB: number;
      scriptsProcessCount: number;
      supported: boolean;
    };
  };
  cpu?: {
    cores: number;
    loadAvg1: number;
    loadAvg5: number;
    loadAvg15: number;
    /** load1 / cores * 100, or null on platforms without loadavg (Windows). */
    loadPercent: number | null;
  };
  connections: {
    wsClients: number;
    /** Distinct contextIds in the /ws/browser registry (one per open pane). */
    browserWsContexts: number;
    /** Total sockets across those contexts (a shared pane has more than one). */
    browserWsSockets: number;
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
  /** System-wide top CPU consumers (sorted desc) — explains a high PC load. */
  topProcesses?: { pid: number; cpu: number; command: string }[];
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
