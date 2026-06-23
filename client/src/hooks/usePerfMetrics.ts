import { useEffect, useState } from 'react';

export interface PerfMetrics {
  version: string;
  cpu: { renderer: number; gpu: number; total: number };
  gpu: { accelerated: boolean; compositing: string; webgl: string };
}

/**
 * Polls Electron's per-process performance metrics while `active`. Returns null
 * in web mode (no `electronAPI.perf`) or until the first sample lands. Only the
 * status dropdown turns this on — there's no point sampling CPU when nobody is
 * looking at it.
 */
export function usePerfMetrics(active: boolean, intervalMs = 1500): PerfMetrics | null {
  const [metrics, setMetrics] = useState<PerfMetrics | null>(null);

  useEffect(() => {
    const getMetrics = window.electronAPI?.perf?.getMetrics;
    if (!active || typeof getMetrics !== 'function') return;
    let alive = true;
    const tick = async () => {
      try {
        const m = await getMetrics();
        if (alive) setMetrics(m);
      } catch { /* transient — keep last sample */ }
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => { alive = false; clearInterval(id); };
  }, [active, intervalMs]);

  return metrics;
}
