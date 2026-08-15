import { Activity, Cpu, MonitorSmartphone, HardDrive } from 'lucide-react';
import { useFps, useFpsHistory, type FpsSample } from '@/lib/fpsMonitor';
import { formatCpuPercent, usePerfMetrics } from '@/hooks/usePerfMetrics';
import { useSystemStatus } from '@/hooks/useSystemStatus';
import { useT } from '@/hooks/useT';

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

function PerfStat({ label, value, color, title, className }: { label: string; value: string; color?: string; title?: string; className?: string }) {
  // Width is controlled by the parent grid (col-span) so the CPU row and the
  // Memory row share the same 4-column rhythm and line up vertically.
  return (
    <div className={`flex flex-col items-center gap-0.5 px-2 py-1 rounded bg-elevated ${className ?? ''}`} title={title}>
      <span className="text-[9px] uppercase tracking-wide text-app-text-muted">{label}</span>
      <span className={`text-[11px] font-medium tabular-nums ${color ?? 'text-app-text'}`}>{value}</span>
    </div>
  );
}

/**
 * Performance diagnostics for the status dropdown. Renders instantly (not lazy)
 * so opening the dropdown shows the live FPS history with no spinner. It answers
 * the "why is it slow?" question on two axes:
 *   • Topics — renderer FPS history + the shell process' memory/CPU (Tauri).
 *   • PC — system load average + GPU hardware-acceleration status.
 */
export function PerfSection() {
  const tr = useT();
  const fps = useFps();
  const history = useFpsHistory();
  const perf = usePerfMetrics(true);
  // Self-poll at 3s — PerfSection only mounts while the dropdown is open, so this
  // fast poll (PC load + top CPU processes) is "live, only while you're looking".
  const { status } = useSystemStatus(true, 3000);

  const avg = history.length
    ? Math.round(history.reduce((s, d) => s + d.fps, 0) / history.length)
    : 0;

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
      // `electron` dropped from the match: the shell was archived in v2.0.0, so
      // no process on this machine is ever named after it — the alternation
      // could only ever produce a false positive on someone else's app.
      const e = m.get(p.command) ?? { cpu: 0, count: 0, isTopics: /topics/i.test(p.command) };
      e.cpu += p.cpu;
      e.count += 1;
      m.set(p.command, e);
    }
    return [...m.entries()].sort((a, b) => b[1].cpu - a[1].cpu).slice(0, 5);
  })();

  // `perf.partial` is true only where the shell can't attribute its child
  // processes (Windows/Linux); on macOS these figures now cover the whole app.
  // `perf?.memory` (not just `perf`): a renderer running ahead of an un-rebuilt
  // shell gets a payload without `memory`, so guard the whole block.
  const serverMemMB = status?.server.memoryMB ?? null;
  // The server side is not one process: the pty-bridge tree (claude CLIs, MCP
  // servers, headless Chromes), the ai-bridge and the WebRTC sidecar are all
  // launchd-reparented children of the server that the shell's attribution set
  // can't see. `fleet` is that whole set, summed from `ps rss`; `serverMemMB`
  // (the Bun process alone) is the fallback where `ps` isn't usable.
  const fleet = status?.server.fleet;
  const serverSideMemMB = fleet?.memoryMB ?? serverMemMB;
  const serverSideProcs = fleet?.processCount ?? 1;
  const mem = perf?.memory ?? null;
  const isPartial = perf?.partial ?? false;
  // Shell footprint + server-side RSS. Different metrics, shown as one headline
  // because the question it answers ("quanto costa Topics?") has one answer; the
  // tiles below split it back apart and the tooltips name each metric.
  const totalMemMB = mem ? mem.totalMB + (serverSideMemMB ?? 0) : serverSideMemMB;
  const memLabel = mem?.metric === 'footprint' ? 'footprint' : 'RSS';
  const serverSideTitle = fleet
    ? tr('perf.serverTitleFleet', { n: fleet.processCount })
      + fleet.roots
          .filter(r => r.kind !== 'server' && r.processCount > 0)
          .map(r => tr('perf.serverTitleRoot', { kind: r.kind, procs: r.processCount, mb: r.memoryMB }))
          .join('')
      + `${status?.server ? tr('perf.serverTitleHeap', { mb: status.server.heapUsedMB }) : ''}`
    : tr('perf.serverTitleSingle') + `${status?.server ? tr('perf.serverTitleHeapShort', { mb: status.server.heapUsedMB }) : ''}`;

  // How much of the footprint the OS has had to compress or swap out. Measured at
  // 6937 MB footprint against 610 MB resident with ~20 browser panes open — the
  // paging that ratio implies, not the GPU, is what makes the UI stutter, so it
  // gets said out loud instead of hiding behind a healthy-looking resident figure.
  const compressedMB = mem && !isPartial ? Math.max(0, mem.totalMB - mem.residentMB) : 0;

  // Bottleneck verdict — only the unambiguous calls. We no longer guess "PC
  // saturated by other processes": the top-process list below shows the actual
  // culprits, so the user reads it directly instead of being told.
  let verdict: { text: string; color: string } | null = null;
  if (perf && accelerated === false) {
    verdict = { text: tr('perf.verdict.noAccel'), color: 'text-red-500' };
  } else if (compressedMB > 2048) {
    verdict = {
      text: tr('perf.verdict.compressed', { gb: (compressedMB / 1024).toFixed(1) }),
      color: 'text-amber-500',
    };
    // Soglia su scala 0-100 dell'intera macchina (vedi `usePerfMetrics`): metà
    // macchina presa dalla sola shell è già "sotto carico". Era `> 100`, che
    // aveva senso finché il numero era per-core e poteva arrivare a 1200.
  } else if (perf && (perf.cpu.total ?? 0) > 50) {
    verdict = { text: tr('perf.verdict.loaded'), color: 'text-amber-500' };
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
          <span className={`text-[15px] font-semibold leading-none ${fpsColor(fps)}`}>{fps || '-'}</span>
          <span className="text-[10px] text-app-text-muted">avg {avg || '-'}</span>
        </span>
      </div>
      <FpsSparkline data={history} />

      {/* CPU cost. Under Tauri only the shell process is measurable (renderer/GPU
          CPU live in WKWebView's XPC processes we can't attribute), so we show the
          shell figure quando c'è UNA MISURA: `total !== null`. Il gate era `> 0`, e
          uno zero misurato — cioè una shell ferma — perdeva la riga insieme al
          caso "baseline non ancora arrivata".
          The pre-Tauri renderer+GPU split is kept for a shell that reports it. */}
      {perf && isPartial && perf.cpu.total !== null && (
        <div className="grid grid-cols-4 gap-1.5">
          <PerfStat
            label="CPU shell"
            className="col-span-4"
            value={`${formatCpuPercent(perf.cpu.total)}%`}
            color={perf.cpu.total > 50 ? 'text-amber-500' : 'text-app-text'}
            title={tr('perf.cpuShellTitle')}
          />
        </div>
      )}
      {perf && !isPartial && perf.cpu.total !== null && (
        <div className="grid grid-cols-4 gap-1.5">
          <PerfStat
            label="CPU Topics"
            className="col-span-2"
            value={`${formatCpuPercent(perf.cpu.total)}%`}
            color={perf.cpu.total > 50 ? 'text-amber-500' : 'text-app-text'}
            title={[
              tr('perf.cpuAllTitle', { n: mem?.processCount ?? '?' }),
              perf.cpu.pids > 0 && perf.cpu.sampled < perf.cpu.pids
                ? tr('perf.cpuSampled', { sampled: perf.cpu.sampled, pids: perf.cpu.pids })
                : null,
            ].filter(Boolean).join(' · ')}
          />
          <PerfStat
            label="Renderer"
            value={`${formatCpuPercent(perf.cpu.renderer)}%`}
            title={tr('perf.cpuRendererTitle')}
          />
          <PerfStat
            label="GPU"
            value={`${formatCpuPercent(perf.cpu.gpu)}%`}
            title={tr('perf.cpuGpuTitle')}
          />
        </div>
      )}
      {/* The server side has its own CPU cost and it is not small — the WebRTC
          sidecar alone measured ~29% while streaming a pane, and the agent CLIs
          under the pty-bridge dwarf it. The shell figures above can't see any of
          it: those processes belong to the server, not to the shell. */}
      {/* Gate su `fleet`, non su `cpuPercent > 0`: questa cifra viene da `ps`,
          che risponde sempre — non ha il problema della baseline che ha la CPU
          della shell. Uno zero qui è una MISURA (il lato server è fermo), e
          nasconderlo ripeterebbe l'errore appena corretto sull'altra metà.

          Scala 0-100 dell'INTERA macchina: il server divide già per i core
          (`fleet-usage.ts`). Prima era la somma per-core di `ps`, che accanto
          alla CPU di sistema si leggeva come una contraddizione — "170%" su un
          Mac al 30%, che sono 1,7 core su 12. La soglia d'allarme è quindi
          metà macchina, non più 100. */}
      {fleet && (
        <div className="grid grid-cols-4 gap-1.5">
          <PerfStat
            label={tr('perf.cpuServerSideLabel', { n: serverSideProcs })}
            className="col-span-4"
            value={`${formatCpuPercent(fleet.cpuPercent)}%`}
            color={fleet.cpuPercent > 50 ? 'text-amber-500' : 'text-app-text'}
            title={tr('perf.cpuServerTitle', { cores: fleet.cpuCores }) + fleet.roots
              .filter(r => r.kind !== 'server' && r.cpuPercent > 0)
              .map(r => tr('perf.cpuServerRoot', { kind: r.kind, pct: r.cpuPercent }))
              .join('')}
          />
        </div>
      )}

      {/* Memory — the honest process figures. Where the shell can attribute its
          children (macOS) this is the WHOLE app; `isPartial` keeps the old
          shell-only labelling truthful everywhere else. */}
      <div
        className="flex items-center justify-between px-0.5 pt-0.5"
        title={(isPartial
          ? tr('perf.memShellTitle')
          : memLabel === 'footprint'
            ? tr('perf.memFootprintTitle', { n: mem?.processCount ?? '?' })
            : tr('perf.memRssTitle'))
          + tr('perf.memPlus', { rest: `${serverSideTitle.charAt(0).toLowerCase()}${serverSideTitle.slice(1)}` })}
      >
        <span className="flex items-center gap-1.5 text-[11px] text-app-text-muted">
          <HardDrive size={12} /> {tr('perf.memLabel')}{' '}
          <span className="text-[9px] opacity-60">
            {isPartial
              ? tr('perf.memShellPlusServer', { n: serverSideProcs })
              : tr('perf.memProcesses', { n: (mem?.processCount ?? 0) + serverSideProcs, metric: memLabel })}
          </span>
        </span>
        <span className="tabular-nums text-[13px] font-semibold text-app-text">
          {totalMemMB !== null ? `${totalMemMB} MB` : '-'}
        </span>
      </div>
      {/* The resident slice. Without it the footprint headline is unreadable: the
          user can't tell "6 GB in RAM" (bad) from "6 GB of which 600 MB in RAM,
          the rest compressed" (bad differently, and fixed by closing panes). */}
      {!isPartial && mem && (
        <div
          className="flex items-center justify-between px-0.5 text-[10px] text-app-text-muted"
          title={tr('perf.residentTitle')}
        >
          <span>{tr('perf.residentLabel')}</span>
          <span className="tabular-nums">
            {mem.residentMB} MB
            {compressedMB > 0 && (
              <span className={compressedMB > 2048 ? 'text-amber-500' : ''}>
                {' '}· {tr('perf.compressed', { n: compressedMB })}
              </span>
            )}
          </span>
        </div>
      )}
      <div className="grid grid-cols-4 gap-1.5">
        {isPartial && mem ? (
          <>
            <PerfStat
              label="Topics (shell)"
              className="col-span-2"
              value={`${mem.totalMB}MB`}
              title={tr('perf.shellRssTitle')}
            />
            <PerfStat
              label={fleet ? tr('perf.serverSideLabel', { n: serverSideProcs }) : tr('perf.serverBun')}
              className="col-span-2"
              value={serverSideMemMB !== null ? `${serverSideMemMB}MB` : tr('perf.na')}
              title={serverSideTitle}
            />
          </>
        ) : mem ? (
          <>
            <PerfStat
              label="Renderer"
              value={`${mem.rendererMB}MB`}
              title={tr('perf.memRendererTitle')}
            />
            <PerfStat label="GPU" value={`${mem.gpuMB}MB`} title={tr('perf.memGpuTitle')} />
            <PerfStat label={tr('perf.otherLabel')} value={`${mem.otherMB}MB`} title={tr('perf.memOtherTitle')} />
            <PerfStat
              label={fleet ? tr('perf.serverN', { n: serverSideProcs }) : tr('perf.server')}
              value={serverSideMemMB !== null ? `${serverSideMemMB}MB` : tr('perf.na')}
              title={serverSideTitle}
            />
          </>
        ) : (
          <PerfStat
            label={fleet ? tr('perf.serverSideLabel', { n: serverSideProcs }) : tr('perf.server')}
            className="col-span-4"
            value={serverSideMemMB !== null ? `${serverSideMemMB}MB` : tr('perf.na')}
            title={fleet
              ? serverSideTitle + tr('perf.webNoShellMem')
              : tr('perf.webNoPerProcess')}
          />
        )}
      </div>

      {/* DOVE STA la memoria del lato server, scritta invece che nascosta.
          Il payload porta `fleet.roots` da sempre e il suo commento dice
          testualmente «so the dropdown can say WHERE the memory is», ma l'unico
          posto che lo leggeva era un `title=`, cioe' un tooltip: per vederlo
          bisognava gia' sospettare che ci fosse qualcosa da vedere. E la
          differenza fra le due letture non e' cosmetica. Il 2026-08-15 questa
          stessa cifra e' passata da ~1,2 GB a 328 MB perche' il server smetteva
          di scaldare otto contesti Chromium all'avvio: quei ~950 MB stavano
          sotto la radice `server`, sommati dentro un totale che non li nominava.
          Una riga che dice «server 328 MB su 3 processi, pty-bridge 20 MB su 1»
          rende quel salto leggibile mentre succede, invece che a posteriori con
          `ps`.
          Solo le radici con memoria, e solo quando ce n'e' piu' di una: una riga
          che ripete il totale della tessella qui sopra e' rumore. */}
      {fleet && fleet.roots.filter(r => r.memoryMB > 0).length > 1 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-0.5 text-[10px] text-app-text-muted">
          {fleet.roots
            .filter(r => r.memoryMB > 0)
            .sort((a, b) => b.memoryMB - a.memoryMB)
            .map(r => (
              <span key={r.kind} className="tabular-nums whitespace-nowrap">
                {r.kind} <span className="text-app-text">{r.memoryMB} MB</span>
                <span className="opacity-60"> ×{r.processCount}</span>
              </span>
            ))}
        </div>
      )}

      {/* Le sessioni piu' pesanti DENTRO il pty-bridge. `roots` sa dire «il
          pty-bridge tiene 1,2 GB su 14 processi», che e' vero e non serve a
          nessuno: quello che si vuole sapere e' QUALE sessione. Il payload lo
          calcola gia' (`fleet.sessions`) e finora non lo leggeva nessuno. Tre e
          non tutte: qui si decide se andare a chiudere qualcosa, e per quella
          decisione contano le prime. */}
      {fleet && fleet.sessions.length > 0 && (
        <div className="flex flex-col gap-0.5 px-0.5 text-[10px] text-app-text-muted">
          {[...fleet.sessions]
            .sort((a, b) => b.memoryMB - a.memoryMB)
            .slice(0, 3)
            .map(s => (
              <div key={s.sessionId} className="flex items-center justify-between gap-2">
                <span className="truncate">{s.name || s.sessionId}</span>
                <span className="tabular-nums whitespace-nowrap text-app-text">{s.memoryMB} MB</span>
              </div>
            ))}
        </div>
      )}

      {/* GPU acceleration — the single biggest hidden FPS killer */}
      {perf && (
        <div
          className="flex items-center gap-1.5 px-1.5 py-1 rounded text-[10px]"
          title={`gpu_compositing: ${perf.gpu.compositing} · webgl: ${perf.gpu.webgl}`}
        >
          {accelerated ? (
            <>
              <MonitorSmartphone size={11} className="text-emerald-500" />
              <span className="text-app-text-muted">{tr('perf.hwAccel')}</span>
              <span className="text-emerald-500 font-medium ml-auto">{tr('perf.hwAccelOn')}</span>
            </>
          ) : (
            <>
              <Cpu size={11} className="text-red-500" />
              <span className="text-app-text-muted">{tr('perf.softwareRendering')}</span>
              <span className="text-red-500 font-medium ml-auto">{tr('perf.noGpu')}</span>
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
            <span className="text-[9px] text-app-text-muted">{tr('perf.topCpuScope')}</span>
          </div>
          {topByCommand.map(([command, { cpu, count, isTopics }]) => (
            <div key={command} className="flex items-center gap-2 px-1.5 py-0.5 rounded">
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
