import { useEffect, useState } from 'react';
import { isTauri } from '../lib/shell';
import { tauriInvoke } from '../lib/shell/tauri';

export interface PerfMetrics {
  version: string;
  /** CPU % of the measured process(es). Under Tauri only `total` (the shell
   *  process) is real; `renderer`/`gpu` stay 0 because WKWebView's content/GPU
   *  processes aren't attributable (see `partial`). `total` is 0 until the second
   *  poll establishes a CPU baseline — callers should treat 0 as "no reading". */
  cpu: { renderer: number; gpu: number; total: number };
  /** Process memory in MB. Under Tauri this is the SHELL process only (`partial`
   *  true, `metric` 'rss'): `rendererMB`/`gpuMB`/`otherMB` are 0 and `totalMB` is
   *  the shell RSS — NOT the whole-app footprint. `metric` 'footprint' would be
   *  the Activity-Monitor-equivalent figure but no current shell reports it. */
  memory: { totalMB: number; rendererMB: number; gpuMB: number; otherMB: number; processCount: number; metric: 'footprint' | 'rss' };
  gpu: { accelerated: boolean; compositing: string; webgl: string };
  /** True when `memory.totalMB`/`cpu.total` cover only the shell process, not the
   *  full multi-process app. Always true on Tauri today: the macOS WKWebView
   *  content/GPU/networking XPC processes are reparented to launchd and can't be
   *  attributed without private APIs. The UI MUST NOT present a partial figure as
   *  the whole-app total. */
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
    // Tauri's perf_metrics command reports the shell process only (content/GPU are
    // launchd-reparented XPC — honest multi-process attribution is a later phase),
    // so map its small shape onto PerfMetrics with zeroed sub-process figures, a
    // 'rss' metric, and the command's own `partial` flag carried through so the UI
    // can label it truthfully. Web has no native process introspection (null).
    const getMetrics: (() => Promise<PerfMetrics>) | null =
      isTauri
        ? async () => {
            const m = await tauriInvoke<{ version: string; total_mb: number; cpu_percent: number; partial: boolean }>('perf_metrics');
            return {
              version: m.version,
              cpu: { renderer: 0, gpu: 0, total: Math.round(m.cpu_percent) },
              memory: { totalMB: Math.round(m.total_mb), rendererMB: 0, gpuMB: 0, otherMB: 0, processCount: 1, metric: 'rss' },
              gpu: TAURI_GPU,
              partial: m.partial ?? true,
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
