// Per-process performance metrics, unified across Electron / Tauri / web.
// Feeds the status-bar diagnostics dropdown (PORTING-PLAN.md §5b).

import { shellKind } from './index';
import { tauriInvoke } from './tauri';

export interface ShellPerfMetrics {
  version: string;
  /** Real desktop footprint in MB (Electron: summed across processes; Tauri:
   *  shell process only for now — `partial` flags this). */
  totalMB: number;
  cpuPercent: number;
  /** True when the figure is not the full multi-process footprint. */
  partial: boolean;
}

interface TauriPerf {
  version: string;
  total_mb: number;
  cpu_percent: number;
  partial: boolean;
}

/** Returns null on web (no native process introspection). */
export async function getPerfMetrics(): Promise<ShellPerfMetrics | null> {
  switch (shellKind) {
    case 'tauri': {
      const m = await tauriInvoke<TauriPerf>('perf_metrics');
      return { version: m.version, totalMB: m.total_mb, cpuPercent: m.cpu_percent, partial: m.partial };
    }
    default:
      return null;
  }
}
