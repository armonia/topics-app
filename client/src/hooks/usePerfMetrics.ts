import { useEffect, useState } from 'react';
import { isTauri } from '../lib/shell';
import { tauriInvoke } from '../lib/shell/tauri';

export interface PerfMetrics {
  version: string;
  cpu: { renderer: number; gpu: number; total: number };
  /** Real desktop memory of every Electron process (MB). `metric` says which
   *  figure: 'footprint' ≈ Activity Monitor (macOS, RSS+compressed+GPU), or
   *  'rss' (resident only) as the cross-platform fallback. */
  memory: { totalMB: number; rendererMB: number; gpuMB: number; otherMB: number; processCount: number; metric: 'footprint' | 'rss' };
  gpu: { accelerated: boolean; compositing: string; webgl: string };
}

/**
 * Polls the shell's performance metrics while `active`. Returns null in web mode
 * (no native process introspection) or until the first sample lands.
 *
 * Two callers, two cadences: the status-bar dropdown samples fast (1.5s) while
 * open, and the always-mounted status bar samples slowly (~5s) to keep the
 * memory/CPU readout live. To avoid an always-on probe doing useless work, the
 * tick is skipped while the window is hidden (`document.hidden`) and fires once
 * immediately when the window becomes visible again.
 */
/**
 * GPU hardware-acceleration status for the Tauri shell. WKWebView on macOS ALWAYS
 * composites through Core Animation / Metal — there is no software-rasteriser
 * fallback like Chromium's SwiftShader — so acceleration is on by definition.
 *
 * We deliberately do NOT probe this with a WebGL context: creating one in a
 * transparent WKWebView can promote the page to an opaque compositing layer and
 * silently kill the window vibrancy. A static value is both correct (for the macOS
 * target) and side-effect-free. Replaces the old hard-coded `false` that showed a
 * bogus "Accelerazione hardware OFF" alarm.
 */
const TAURI_GPU: PerfMetrics['gpu'] = { accelerated: true, compositing: 'core-animation', webgl: 'webkit' };

export function usePerfMetrics(active: boolean, intervalMs = 1500): PerfMetrics | null {
  const [metrics, setMetrics] = useState<PerfMetrics | null>(null);

  useEffect(() => {
    // Tauri's perf_metrics command reports the shell process only (content/GPU are
    // launchd-reparented XPC — honest multi-process attribution is a later phase),
    // so map its small shape onto PerfMetrics with zeroed sub-process figures and a
    // 'rss' metric. Web has no native process introspection (null).
    const getMetrics: (() => Promise<PerfMetrics>) | null =
      isTauri
        ? async () => {
            const m = await tauriInvoke<{ version: string; total_mb: number; cpu_percent: number }>('perf_metrics');
            return {
              version: m.version,
              cpu: { renderer: 0, gpu: 0, total: m.cpu_percent },
              memory: { totalMB: Math.round(m.total_mb), rendererMB: 0, gpuMB: 0, otherMB: 0, processCount: 1, metric: 'rss' },
              gpu: TAURI_GPU,
            };
          }
        : null;
    if (!active || !getMetrics) return;
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
