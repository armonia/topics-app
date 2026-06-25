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

interface ElectronPerf {
  getMetrics(): Promise<{
    version: string;
    cpu: { total: number };
    memory: { totalMB: number };
  }>;
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
    case 'electron': {
      const api = (window as unknown as { electronAPI?: { perf?: ElectronPerf } }).electronAPI?.perf;
      if (!api?.getMetrics) return null;
      const m = await api.getMetrics();
      return { version: m.version, totalMB: m.memory.totalMB, cpuPercent: m.cpu.total, partial: false };
    }
    case 'tauri': {
      const m = await tauriInvoke<TauriPerf>('perf_metrics');
      return { version: m.version, totalMB: m.total_mb, cpuPercent: m.cpu_percent, partial: m.partial };
    }
    default:
      return null;
  }
}
