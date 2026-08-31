import { formatCpuPercent } from '@/hooks/usePerfMetrics';
import type { PerfMetrics } from '@/hooks/usePerfMetrics';
import type { SystemStatus } from '@/hooks/useSystemStatus';
import { computeTopicsFootprint } from '@/lib/topicsFootprint';
import { mostraResidenteInBarra } from './verdict';

/**
 * WHAT THE HEADLINE NUMBER IS MADE OF, as one string.
 *
 * This used to live inline in `SidebarStatusBar`, on the dense strip at the
 * foot of the column, and the strip is gone: the same three facts are rows in
 * the «Topics» menu now (`SidebarSystemMenu`). The composition came here rather
 * than moving to the new host because it is the one part of that strip with no
 * markup in it at all — it is a paragraph, it is long, and it is the only piece
 * a test can check without a browser.
 *
 * THE ORDER IS THE READING ORDER, and it is load-bearing: the total first, its
 * two halves next, the inventory of what holds it last. Somebody hovering is
 * after the number; what composes it is the question AFTER, and putting it in
 * front pushes the answer off the top of the tooltip. RES-ATTR-11 asserts the
 * order, not just the presence.
 */
export interface UsageTooltipInput {
  /** Phone or computer: only changes the word that names the device half. */
  isMobile: boolean;
  /** Shell process metrics (Tauri). Null in a browser, which the text says. */
  perf: PerfMetrics | null;
  /** Server + fleet snapshot. */
  status: SystemStatus | null;
  /** Frames per second measured in this window; 0 when not sampling. */
  fps: number;
  /** «di cui in RAM adesso: N MB», already translated by the caller. Null when
   *  the resident share is not worth a line (see `mostraResidenteInBarra`). */
  residentLine: string | null;
  /** The hover-gated inventory (`bloccoTooltip`), null until somebody looks. */
  inventory: string | null;
}

const fmtMB = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${mb}MB`);
const partialSign = (partial: boolean) => (partial ? '~' : '');

/** The footprint the tooltip describes. Exported because the caller needs the
 *  same numbers for the visible chip, and computing them twice is how the chip
 *  and its own tooltip end up disagreeing. */
export function usageFrom(perf: PerfMetrics | null, status: SystemStatus | null) {
  const isPartialMem = perf?.partial ?? false;
  const appMemMB = perf?.memory?.totalMB ?? null;
  const serverMemMB = status?.server.memoryMB ?? null;
  const fleet = status?.server.fleet;
  const serverSideMemMB = fleet?.memoryMB ?? serverMemMB;
  return computeTopicsFootprint({
    deviceMB: appMemMB,
    deviceProcessCount: perf?.memory?.processCount ?? 0,
    devicePartial: isPartialMem,
    deviceCpu: perf?.cpu.total ?? null,
    serverMB: serverSideMemMB,
    serverProcessCount: fleet?.processCount ?? (serverMemMB !== null ? 1 : 0),
    serverMetric: fleet?.memMetric ?? 'rss',
    serverCpu: fleet?.cpuPercent ?? null,
    scriptsMB: fleet?.scriptsMB ?? 0,
    scriptsProcessCount: fleet?.scriptsProcessCount ?? 0,
    sampleKey: status?.timestamp,
  });
}

/** True when the resident share deserves its own line. Kept next to the
 *  composition so the caller does not have to know the rule to translate it. */
export function wantsResidentLine(perf: PerfMetrics | null, status: SystemStatus | null): boolean {
  const usage = usageFrom(perf, status);
  const fleet = status?.server.fleet;
  return mostraResidenteInBarra({
    totalMB: usage.totalMB,
    residentMB: perf?.memory?.residentMB ?? null,
    serverMB: fleet?.memoryMB ?? status?.server.memoryMB ?? null,
    partial: perf?.partial ?? false,
  });
}

export function composeUsageTooltip(input: UsageTooltipInput): string {
  const { isMobile, perf, status, fps, residentLine, inventory } = input;
  const isPartialMem = perf?.partial ?? false;
  const appMemMB = perf?.memory?.totalMB ?? null;
  const residentMemMB = perf?.memory?.residentMB ?? null;
  const procCount = perf?.memory?.processCount ?? null;
  const memMetric = perf?.memory?.metric;
  const shellCpu = perf?.cpu.total ?? null;
  const serverMemMB = status?.server.memoryMB ?? null;
  const fleet = status?.server.fleet;
  const fleetCpu = fleet?.cpuPercent ?? null;
  const usage = usageFrom(perf, status);

  const deviceTitle = [
    isMobile ? 'Questo telefono' : 'Questo computer',
    appMemMB !== null
      ? (isPartialMem
          ? `Topics (processo shell): ${appMemMB} MB di ${memMetric === 'footprint' ? 'footprint' : 'memoria residente (RSS)'}\n· NON include i processi WKWebView (contenuto browser dei pannelli)`
          : `Topics, ${procCount ?? '?'} processi: ${appMemMB} MB di footprint, lo stesso valore di Monitoraggio Attività\n· di cui in RAM adesso: ${residentMemMB ?? '-'} MB (il resto è compresso o in swap)`)
      : 'memoria e CPU non misurabili qui: il browser non espone i processi. Sono disponibili solo dentro l’app desktop.',
    shellCpu !== null ? `CPU: ${formatCpuPercent(shellCpu)}% della macchina` : null,
    perf && perf.cpu.pids > 0 && perf.cpu.sampled < perf.cpu.pids
      ? `misurata su ${perf.cpu.sampled}/${perf.cpu.pids} processi · gli altri non hanno ancora un delta`
      : null,
    fps > 0 ? `${fps} fotogrammi al secondo, misurati in questa finestra` : null,
  ].filter(Boolean).join('\n· ');

  const serverTitle = [
    'Il server',
    fleet
      ? `${fleet.processCount} processi: ${fleet.memoryMB} MB`
        + (fleet.memMetric === 'footprint' ? ' di footprint' : fleet.memMetric === 'mixed' ? ' (footprint parziale)' : ' (RSS, stima alta)')
      : `processo Bun: ${serverMemMB ?? '-'} MB` + (status ? ` (heap ${status.server.heapUsedMB} MB)` : ''),
    fleetCpu !== null ? `CPU: ${formatCpuPercent(fleetCpu)}% della macchina` : 'CPU: non misurata',
    ...(fleet
      ? fleet.roots.filter((r) => r.kind !== 'server' && r.memoryMB > 0)
          .map((r) => `${r.kind}: ${r.memoryMB} MB, ${r.processCount} proc.`)
      : []),
  ].filter(Boolean).join('\n· ');

  return [
    'Topics in tutto',
    usage.totalMB !== null
      ? `memoria: ${partialSign(usage.memPartial)}${fmtMB(usage.totalMB)} su ${usage.totalProcessCount} processi`
      : 'memoria: non misurata',
    residentLine,
    usage.totalCpu !== null
      ? `CPU: ${partialSign(usage.cpuPartial)}${formatCpuPercent(usage.totalCpu)}% della macchina`
      : 'CPU: non ancora misurata',
    usage.memPartial || usage.cpuPartial
      ? `«~» = totale parziale: ${appMemMB === null
          ? 'di qui i processi non si misurano, c’è solo il lato server'
          : 'la lettura del dispositivo copre la sola shell'}`
      : null,
  ].filter(Boolean).join('\n· ')
    + `\n\n${deviceTitle}\n\n${serverTitle}`
    + (inventory ? `\n\n${inventory}` : '');
}
