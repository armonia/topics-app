import { Activity, Cpu, MonitorSmartphone, HardDrive } from 'lucide-react';
import { useFps, useFpsHistory, type FpsSample } from '@/lib/fpsMonitor';
import { usePerfMetrics } from '@/hooks/usePerfMetrics';
import { useSystemStatus } from '@/hooks/useSystemStatus';

const SPARK_W = 288;
const SPARK_H = 40;

function fpsColor(fps: number): string {
  if (fps <= 0) return 'text-app-text-muted';
  if (fps < 30) return 'text-red-500';
  if (fps < 50) return 'text-amber-500';
  return 'text-emerald-500';
}

function FpsSparkline({ data }: { data: FpsSample[] }) {
  if (data.length < 2) {
    return (
      <div
        className="rounded bg-elevated flex items-center justify-center text-[10px] text-app-text-muted"
        style={{ height: SPARK_H }}
      >
        campionamento…
      </div>
    );
  }

  // Scale to the highest observed rate but never below 60 so a steady 60fps
  // line doesn't peg the top of the chart and a 120Hz display still fits.
  const maxObserved = data.reduce((m, d) => Math.max(m, d.fps), 0);
  const ceil = Math.max(60, Math.ceil(maxObserved / 30) * 30);
  const n = data.length;
  const x = (i: number) => (i / (n - 1)) * SPARK_W;
  const y = (fps: number) => SPARK_H - (Math.min(fps, ceil) / ceil) * SPARK_H;

  const line = data.map((d, i) => `${x(i).toFixed(1)},${y(d.fps).toFixed(1)}`).join(' ');
  const area = `0,${SPARK_H} ${line} ${SPARK_W},${SPARK_H}`;
  const y60 = y(60);
  const y30 = y(30);
  const last = data[data.length - 1].fps;
  const stroke = last < 30 ? '#ef4444' : last < 50 ? '#f59e0b' : '#10b981';

  return (
    <svg
      width="100%"
      height={SPARK_H}
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      className="rounded bg-elevated"
    >
      {/* 60fps + 30fps reference guides */}
      <line x1="0" x2={SPARK_W} y1={y60} y2={y60} stroke="currentColor" strokeWidth="0.5" className="text-app-text-muted/30" strokeDasharray="3 3" />
      <line x1="0" x2={SPARK_W} y1={y30} y2={y30} stroke="currentColor" strokeWidth="0.5" className="text-red-500/25" strokeDasharray="3 3" />
      <polyline points={area} fill={stroke} fillOpacity="0.12" stroke="none" />
      <polyline points={line} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function PerfStat({ label, value, color, title }: { label: string; value: string; color?: string; title?: string }) {
  return (
    <div className="flex-1 flex flex-col items-center gap-0.5 px-2 py-1 rounded bg-elevated" title={title}>
      <span className="text-[9px] uppercase tracking-wide text-app-text-muted">{label}</span>
      <span className={`text-[11px] font-medium tabular-nums ${color ?? 'text-app-text'}`}>{value}</span>
    </div>
  );
}

/**
 * Performance diagnostics for the status dropdown. Renders instantly (not lazy)
 * so opening the dropdown shows the live FPS history with no spinner. It answers
 * the "why is it slow?" question on two axes:
 *   • Topics — renderer FPS history + renderer-process CPU (Electron).
 *   • PC — system load average + GPU hardware-acceleration status.
 */
export function PerfSection() {
  const fps = useFps();
  const history = useFpsHistory();
  const perf = usePerfMetrics(true);
  // Self-poll at 3s — PerfSection only mounts while the dropdown is open, so this
  // fast poll (PC load + top CPU processes) is "live, only while you're looking".
  const { status } = useSystemStatus(true, 3000);

  const avg = history.length
    ? Math.round(history.reduce((s, d) => s + d.fps, 0) / history.length)
    : 0;

  const loadPercent = status?.cpu?.loadPercent ?? null;
  const accelerated = perf?.gpu.accelerated;
  const topProcesses = status?.topProcesses ?? [];

  // Aggregate the system top-CPU list by command name. With ~20 Claude Code
  // terminals running, the raw list is several identical "claude"/"node" rows
  // distinguished only by a hidden PID; summing per name (with a ×count) turns
  // that into one legible "claude ×6  140%" row. CPU is per-core (ps %cpu), so
  // a sum can exceed 100% — the header says "per core".
  const topByCommand = (() => {
    const m = new Map<string, { cpu: number; count: number; isTopics: boolean }>();
    for (const p of topProcesses) {
      const e = m.get(p.command) ?? { cpu: 0, count: 0, isTopics: /topics|electron/i.test(p.command) };
      e.cpu += p.cpu;
      e.count += 1;
      m.set(p.command, e);
    }
    return [...m.entries()].sort((a, b) => b[1].cpu - a[1].cpu).slice(0, 5);
  })();

  // Real footprint = every Electron process + the (separate) Bun server.
  // `perf?.memory` (not just `perf`): a renderer running ahead of an un-rebuilt
  // Electron main gets a payload without `memory`, so guard the whole block.
  const serverMemMB = status?.server.memoryMB ?? null;
  const mem = perf?.memory ?? null;
  const totalMemMB = mem ? mem.totalMB + (serverMemMB ?? 0) : serverMemMB;

  // Bottleneck verdict — only the unambiguous calls. We no longer guess "PC
  // saturated by other processes": the top-process list below shows the actual
  // culprits, so the user reads it directly instead of being told.
  let verdict: { text: string; color: string } | null = null;
  if (perf && accelerated === false) {
    verdict = { text: 'Accelerazione hardware OFF — causa principale dei pochi FPS', color: 'text-red-500' };
  } else if (perf && perf.cpu.renderer > 80) {
    verdict = { text: 'Renderer Topics sotto carico — è Topics a costare', color: 'text-amber-500' };
  }
  // No "Fluido" line in the good case: the FPS headline + sparkline above
  // already say it. The verdict only speaks up when there's a real problem.

  return (
    <div className="px-2 pt-2 pb-1 space-y-1.5 border-b border-app-border">
      {/* FPS headline + sparkline */}
      <div className="flex items-center justify-between px-0.5">
        <span className="flex items-center gap-1.5 text-[11px] text-app-text-muted">
          <Activity size={12} /> FPS Topics
        </span>
        <span className="flex items-baseline gap-2 tabular-nums">
          <span className={`text-[15px] font-semibold leading-none ${fpsColor(fps)}`}>{fps || '—'}</span>
          <span className="text-[10px] text-app-text-muted">avg {avg || '—'}</span>
        </span>
      </div>
      <FpsSparkline data={history} />

      {/* PC vs Topics resource stats */}
      <div className="flex gap-1.5">
        {perf ? (
          <>
            <PerfStat
              label="Renderer"
              value={`${perf.cpu.renderer}%`}
              color={perf.cpu.renderer > 80 ? 'text-amber-500' : 'text-app-text'}
              title="CPU del renderer di Topics — per-processo, può superare 100% (scala diversa da PC load)"
            />
            <PerfStat
              label="GPU"
              value={`${perf.cpu.gpu}%`}
              color={undefined}
              title="CPU del processo GPU/compositor — per-processo, può superare 100% (scala diversa da PC load)"
            />
          </>
        ) : (
          <PerfStat
            label="Renderer"
            value="—"
            title="CPU per-processo disponibile solo nell'app desktop (Electron)"
          />
        )}
        <PerfStat
          label="PC load"
          value={loadPercent !== null ? `${loadPercent}%` : 'n/d'}
          color={loadPercent !== null && loadPercent > 85 ? 'text-amber-500' : 'text-app-text'}
          title={status?.cpu ? `Carico dell'intera macchina (sistema, 0–100%) — load avg ${status.cpu.loadAvg1} su ${status.cpu.cores} core` : 'Carico medio del sistema (0–100%)'}
        />
      </div>

      {/* Memory footprint — the REAL one. The status bar used to show only the
          Bun server's RSS (~70 MB); this is the full desktop figure: every
          Electron process (renderers, GPU, main, utility) + the server. */}
      <div
        className="flex items-center justify-between px-0.5 pt-0.5"
        title="Working set di tutti i processi Electron + RSS del server Bun. Include pagine condivise tra processi, quindi è una leggera sovrastima della memoria unica."
      >
        <span className="flex items-center gap-1.5 text-[11px] text-app-text-muted">
          <HardDrive size={12} /> Memoria <span className="text-[9px] opacity-60">working set</span>
        </span>
        <span className="tabular-nums text-[13px] font-semibold text-app-text">
          {totalMemMB !== null ? `${totalMemMB} MB` : '—'}
          {mem && (
            <span className="text-[10px] font-normal text-app-text-muted ml-1.5">
              {mem.processCount} processi
            </span>
          )}
        </span>
      </div>
      <div className="flex gap-1.5">
        {mem ? (
          <>
            <PerfStat
              label="Renderer"
              value={`${mem.rendererMB}MB`}
              title="Memoria dei processi renderer — finestre + ogni pannello browser nativo (WebContentsView)"
            />
            <PerfStat label="GPU" value={`${mem.gpuMB}MB`} title="Memoria del processo GPU/compositor" />
            <PerfStat label="Altri" value={`${mem.otherMB}MB`} title="Processo main + utility (network, storage, audio) di Electron" />
            <PerfStat
              label="Server"
              value={serverMemMB !== null ? `${serverMemMB}MB` : 'n/d'}
              title={`RSS del processo server Bun${status?.server ? ` · heap ${status.server.heapUsedMB} MB` : ''}`}
            />
          </>
        ) : (
          <PerfStat
            label="Server"
            value={serverMemMB !== null ? `${serverMemMB}MB` : 'n/d'}
            title="In modalità web la memoria per-processo non è disponibile: mostriamo solo l'RSS del server"
          />
        )}
      </div>

      {/* GPU acceleration — the single biggest hidden FPS killer */}
      {perf && (
        <div
          className="flex items-center gap-1.5 px-1.5 py-1 rounded text-[10px]"
          title={`gpu_compositing: ${perf.gpu.compositing} · webgl: ${perf.gpu.webgl}`}
        >
          {accelerated ? (
            <>
              <MonitorSmartphone size={11} className="text-emerald-500" />
              <span className="text-app-text-muted">Accelerazione hardware</span>
              <span className="text-emerald-500 font-medium ml-auto">attiva</span>
            </>
          ) : (
            <>
              <Cpu size={11} className="text-red-500" />
              <span className="text-app-text-muted">Rendering software</span>
              <span className="text-red-500 font-medium ml-auto">no GPU</span>
            </>
          )}
        </div>
      )}

      {/* Top CPU consumers — what's actually loading the PC right now. The user
          asked "perché ho il PC load?": this answers it concretely. */}
      {topByCommand.length > 0 && (
        <div className="space-y-0.5 pt-0.5">
          <div className="flex items-center justify-between px-1.5">
            <span className="text-[9px] uppercase tracking-wide text-app-text-muted">Top CPU</span>
            <span className="text-[9px] text-app-text-muted">sistema · per core</span>
          </div>
          {topByCommand.map(([command, { cpu, count, isTopics }]) => (
            <div key={command} className="flex items-center gap-2 px-1.5 py-0.5 rounded hover:bg-app-hover">
              <span className={`text-[10px] truncate flex-1 ${isTopics ? 'text-primary font-medium' : 'text-app-text-secondary'}`}>
                {command}{count > 1 && <span className="text-app-text-muted"> ×{count}</span>}
              </span>
              <span className={`text-[10px] tabular-nums flex-shrink-0 ${cpu >= 80 ? 'text-amber-500' : 'text-app-text-muted'}`}>
                {Math.round(cpu)}%
              </span>
            </div>
          ))}
        </div>
      )}

      {verdict && (
        <div className={`px-1.5 py-0.5 text-[10px] font-medium ${verdict.color}`}>{verdict.text}</div>
      )}
    </div>
  );
}
