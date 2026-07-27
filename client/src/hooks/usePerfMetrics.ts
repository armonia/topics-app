import { useEffect, useState } from 'react';
import { isTauri } from '../lib/shell';
import { tauriInvoke } from '../lib/shell/tauri';

export interface PerfMetrics {
  version: string;
  /** CPU % summed over the measured processes, split into the same buckets as
   *  `memory`. Per-core like Activity Monitor, so a sum can exceed 100%. `total`
   *  is 0 until the second poll establishes a baseline — callers should treat 0
   *  as "no reading". */
  cpu: { renderer: number; gpu: number; total: number };
  /** Process memory in MB, covering the WHOLE app on macOS: the shell plus every
   *  WKWebView XPC service the kernel attributes to us. `metric` is 'footprint'
   *  there — the same `phys_footprint` Activity Monitor's "Memory" column shows,
   *  so the two agree. `residentMB` is the slice actually in physical RAM; the
   *  gap between it and `totalMB` is memory the OS has compressed or swapped,
   *  which is what makes the UI stutter when it has to be paged back in. */
  memory: {
    totalMB: number;
    residentMB: number;
    rendererMB: number;
    gpuMB: number;
    otherMB: number;
    processCount: number;
    metric: 'footprint' | 'rss';
  };
  gpu: { accelerated: boolean; compositing: string; webgl: string };
  /** True when the figures cover only the shell process rather than the full
   *  multi-process app — the UI MUST NOT present a partial figure as the
   *  whole-app total. False on macOS since the shell learned to attribute the
   *  reparented WKWebView XPC services (`responsibility_get_pid_responsible_for_pid`);
   *  still true on Windows/Linux, which have no equivalent API. */
  partial: boolean;
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
    // Tauri's perf_metrics command aggregates the whole app on macOS and reports
    // footprint (Activity-Monitor-equivalent) plus the resident slice and a
    // renderer/gpu/other split. Its own `partial` flag is carried through rather
    // than assumed, so the UI keeps labelling non-macOS shells truthfully. Web has
    // no native process introspection (null).
    const getMetrics: (() => Promise<PerfMetrics>) | null =
      isTauri
        ? async () => {
            const m = await tauriInvoke<{
              version: string;
              total_mb: number;
              resident_mb: number;
              renderer_mb: number;
              gpu_mb: number;
              other_mb: number;
              cpu_percent: number;
              cpu_renderer: number;
              cpu_gpu: number;
              process_count: number;
              partial: boolean;
            }>('perf_metrics');
            const partial = m.partial ?? true;
            return {
              version: m.version,
              cpu: {
                renderer: Math.round(m.cpu_renderer ?? 0),
                gpu: Math.round(m.cpu_gpu ?? 0),
                total: Math.round(m.cpu_percent),
              },
              memory: {
                totalMB: Math.round(m.total_mb),
                residentMB: Math.round(m.resident_mb ?? m.total_mb),
                rendererMB: Math.round(m.renderer_mb ?? 0),
                gpuMB: Math.round(m.gpu_mb ?? 0),
                otherMB: Math.round(m.other_mb ?? 0),
                processCount: m.process_count || 1,
                // A partial reading is the shell's own resident size, not a
                // footprint — don't mislabel it as the Activity Monitor figure.
                metric: partial ? 'rss' : 'footprint',
              },
              gpu: TAURI_GPU,
              partial,
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
