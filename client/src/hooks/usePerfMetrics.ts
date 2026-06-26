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
/**
 * Probe GPU hardware-acceleration from the renderer itself via WebGL — host-neutral
 * (Tauri's WKWebView exposes no `getGPUFeatureStatus` like Electron's main process).
 * A live WebGL context whose UNMASKED_RENDERER is a real GPU (not a software
 * rasteriser) means compositing is hardware-accelerated. Cached: acceleration can't
 * change at runtime. macOS WKWebView composites via Core Animation/Metal → reports
 * `true` there, fixing the false "Accelerazione hardware OFF" the hard-coded value
 * showed under Tauri.
 */
let gpuProbe: PerfMetrics['gpu'] | null = null;
function probeGpuAcceleration(): PerfMetrics['gpu'] {
  if (gpuProbe) return gpuProbe;
  let renderer = '';
  let accelerated = false;
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'webgl';
      // SwiftShader (Chromium), llvmpipe / "software" (Mesa), Apple's software
      // renderer → software path; anything else (Apple GPU / M-series / a discrete
      // GPU) → hardware.
      accelerated = !/swiftshader|software|llvmpipe|basic render/i.test(renderer);
    } else {
      renderer = 'unavailable';
    }
  } catch {
    renderer = 'error';
  }
  gpuProbe = { accelerated, compositing: accelerated ? 'hardware' : 'software', webgl: renderer };
  return gpuProbe;
}

export function usePerfMetrics(active: boolean, intervalMs = 1500): PerfMetrics | null {
  const [metrics, setMetrics] = useState<PerfMetrics | null>(null);

  useEffect(() => {
    const electronGet = window.electronAPI?.perf?.getMetrics;
    // Electron exposes the rich per-process breakdown. Tauri's perf_metrics
    // command reports the shell process only (content/GPU are launchd-reparented
    // XPC — honest multi-process attribution is a later phase), so map its small
    // shape onto PerfMetrics with zeroed sub-process figures and a 'rss' metric.
    const getMetrics: (() => Promise<PerfMetrics>) | null =
      typeof electronGet === 'function'
        ? electronGet
        : isTauri
          ? async () => {
              const m = await tauriInvoke<{ version: string; total_mb: number; cpu_percent: number }>('perf_metrics');
              return {
                version: m.version,
                cpu: { renderer: 0, gpu: 0, total: m.cpu_percent },
                memory: { totalMB: Math.round(m.total_mb), rendererMB: 0, gpuMB: 0, otherMB: 0, processCount: 1, metric: 'rss' },
                gpu: probeGpuAcceleration(),
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
