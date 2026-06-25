import { useEffect, useState } from 'react';

export interface PerfMetrics {
  version: string;
  cpu: { renderer: number; gpu: number; total: number };
  /** Real desktop footprint: working set of every Electron process (MB). */
  memory: { totalMB: number; rendererMB: number; gpuMB: number; otherMB: number; processCount: number };
  gpu: { accelerated: boolean; compositing: string; webgl: string };
}

/**
 * Polls Electron's per-process performance metrics while `active`. Returns null
 * in web mode (no `electronAPI.perf`) or until the first sample lands.
 *
 * Two callers, two cadences: the status-bar dropdown samples fast (1.5s) while
 * open, and the always-mounted status bar samples slowly (~5s) to keep the
 * memory/CPU readout live. To avoid an always-on probe doing useless work, the
 * tick is skipped while the window is hidden (`document.hidden`) — each metrics
 * call walks every Chromium process via `app.getAppMetrics()` — and fires once
 * immediately when the window becomes visible again.
 */
export function usePerfMetrics(active: boolean, intervalMs = 1500): PerfMetrics | null {
  const [metrics, setMetrics] = useState<PerfMetrics | null>(null);

  useEffect(() => {
    const getMetrics = window.electronAPI?.perf?.getMetrics;
    if (!active || typeof getMetrics !== 'function') return;
    let alive = true;
    const tick = async () => {
      if (document.hidden) return; // don't probe the process tree when unseen
      try {
        const m = await getMetrics();
        if (alive) setMetrics(m);
      } catch { /* transient — keep last sample */ }
    };
    tick();
    const id = setInterval(tick, intervalMs);
    const onVisible = () => { if (!document.hidden) tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, intervalMs]);

  return metrics;
}
