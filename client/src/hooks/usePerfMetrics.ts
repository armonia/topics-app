import { useEffect, useState } from 'react';
import { isTauri } from '../lib/shell';
import { tauriInvoke } from '../lib/shell/tauri';

export interface PerfMetrics {
  version: string;
  /**
   * CPU % summed over i processi misurati, con lo stesso split di `memory`.
   * Per-core come Activity Monitor, quindi la somma può superare 100%.
   *
   * `total` è **`null` quando non c'è una misura** (nessun pid aveva ancora un
   * campione precedente su cui fare il delta), e un numero — anche `0` — quando
   * la misura c'è. Prima era `0` in entrambi i casi e i due lettori nascondevano
   * il chip su `> 0`: così un'app FERMA faceva sparire il contatore, che è il
   * momento in cui "0%" è l'informazione utile. `null` e `0` ora sono due stati
   * distinti e si vedono distinti.
   *
   * `sampled`/`pids`: quanti processi hanno contribuito al totale su quanti ce
   * n'erano. `sampled < pids` ⇒ copertura parziale (una pane appena aperta non ha
   * ancora un delta): la somma è vera ma incompleta, e va detto invece di
   * lasciarla passare per il totale dell'app.
   */
  cpu: { renderer: number; gpu: number; total: number | null; sampled: number; pids: number };
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

/**
 * Percentuale di CPU come stringa, senza far sparire una misura piccola.
 *
 * `Math.round` mandava a `0` tutto ciò che stava sotto lo 0,5% — e i lettori
 * nascondevano il chip sullo zero, quindi un valore reale di 0,4% diventava
 * "nessun contatore". Sotto l'1% si scrive `<1`, che dice la verità (è acceso, sta
 * misurando, il valore è minuscolo) invece di sparire.
 */
export function formatCpuPercent(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (v < 1) return '<1';
  return String(Math.round(v));
}

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
              cpu_percent: number | null;
              cpu_renderer: number;
              cpu_gpu: number;
              cpu_sampled?: number;
              cpu_pids?: number;
              process_count: number;
              partial: boolean;
            }>('perf_metrics');
            const partial = m.partial ?? true;
            return {
              version: m.version,
              cpu: {
                // Non arrotondati qui: `formatCpuPercent` decide come si scrivono,
                // così un valore piccolo ma reale non diventa uno zero prima di
                // arrivare alla UI.
                renderer: m.cpu_renderer ?? 0,
                gpu: m.cpu_gpu ?? 0,
                // `null` = nessuna misura. `?? null` copre anche uno shell vecchio
                // che non manda ancora il campo: assente ⇒ non misurato, non zero.
                total: m.cpu_percent ?? null,
                sampled: m.cpu_sampled ?? 0,
                pids: m.cpu_pids ?? 0,
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
