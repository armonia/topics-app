import { Activity, Cpu, HardDrive } from 'lucide-react';
import { useFps, useFpsHistory, type FpsSample } from '@/lib/fpsMonitor';
import { formatCpuPercent, usePerfMetrics } from '@/hooks/usePerfMetrics';
import { useSystemStatus } from '@/hooks/useSystemStatus';
import { computeTopicsFootprint } from '@/lib/topicsFootprint';
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


  // `perf.partial` is true only where the shell can't attribute its child
  // processes (Windows/Linux); on macOS these figures now cover the whole app.
  // `perf?.memory` (not just `perf`): a renderer running ahead of an un-rebuilt
  // shell gets a payload without `memory`, so guard the whole block.
  const fleet = status?.server.fleet;
  const mem = perf?.memory ?? null;
  const isPartial = perf?.partial ?? false;

  // Calcolatore unico: combina shell + server con EMA per smorzare le oscillazioni.
  // Usa computeTopicsFootprint invece di sommare direttamente qui.
  const footprint = computeTopicsFootprint(
    mem?.totalMB ?? null,
    mem?.processCount ?? 0,
    isPartial,
    fleet?.memoryMB ?? (status?.server.memoryMB ?? 0),
    fleet?.processCount ?? 1,
    fleet?.memMetric ?? 'rss',
    fleet?.scriptsMB ?? 0,
    fleet?.scriptsProcessCount ?? 0,
  );

  const totalMemMB = footprint.totalMB > 0 ? footprint.totalMB : null;
  const serverSideMemMB = footprint.serverMB;
  const serverSideProcs = footprint.serverProcessCount;

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
    <div className="px-2 pt-2 pb-1 space-y-2 border-b border-app-border">
      {/* TRE DOMANDE, IN QUEST'ORDINE. Prima erano nove blocchi di numeri con
          etichette diverse per la stessa cosa ("CPU shell", "CPU Topics",
          "Renderer", "GPU", "server-side", "Topics (shell)", "residente",
          "compressa"): segnalato come «troppa informazione messa in maniera
          confusionaria», ed era vero - ogni riga era difendibile da sola e
          insieme non rispondevano a niente.
          Adesso: 1) va veloce? 2) quanto costa? 3) c'e' qualcosa che non va?
          Il dettaglio non sparisce, scende nei tooltip: chi vuole il numero per
          processo lo trova dove si cercano i dettagli, non davanti. */}

      {/* 1 · VA VELOCE? Gli fps sono l'unica cosa che l'utente SENTE. */}
      <div>
        <div className="flex items-center justify-between px-0.5">
          <span className="flex items-center gap-1.5 text-[11px] text-app-text-muted">
            <Activity size={12} /> {tr('perf.q1')}
          </span>
          <span className="flex items-baseline gap-2 tabular-nums">
            <span className={`text-[15px] font-semibold leading-none ${fpsColor(fps)}`}>{fps || '-'}</span>
            <span className="text-[10px] text-app-text-muted">{tr('perf.fpsAvg', { n: avg || '-' })}</span>
          </span>
        </div>
        <FpsSparkline data={history} />
      </div>

      {/* 2 · QUANTO COSTA? UN numero, non cinque tessere.
          La somma e' quella che si andrebbe a leggere in Monitoraggio Attivita'
          se si sapesse quali processi sommare - ed e' la ragione per cui il
          conto lo fa l'app invece di lasciarlo a chi guarda. Il dettaglio
          (shell, renderer, GPU, lato server, quanto e' compresso) sta nel
          tooltip: e' la risposta alla domanda DOPO, e prima confondeva questa. */}
      <div className="space-y-1">
        <div
          data-testid="perf-cost"
          className="flex items-center justify-between px-0.5"
          title={[
            isPartial ? tr('perf.memShellTitle')
              : footprint.serverMetric === 'footprint' ? tr('perf.memFootprintTitle', { n: mem?.processCount ?? '?' })
              : tr('perf.memRssTitle'),
            serverSideTitle,
            !isPartial && mem ? tr('perf.residentInline', { mb: mem.residentMB }) : null,
            compressedMB > 0 ? tr('perf.compressedInline', { n: compressedMB }) : null,
            perf?.cpu.total !== null && perf ? tr('perf.cpuInline', { pct: formatCpuPercent(perf.cpu.total) }) : null,
            fleet ? tr('perf.cpuServerInline', { pct: formatCpuPercent(fleet.cpuPercent) }) : null,
          ].filter(Boolean).join('\n')}
        >
          <span className="flex items-center gap-1.5 text-[11px] text-app-text-muted">
            <HardDrive size={12} /> {tr('perf.q2')}
            <span className="text-[9px] opacity-60">
              {tr('perf.procCount', { n: (mem?.processCount ?? 0) + serverSideProcs })}
            </span>
          </span>
          <span className="tabular-nums text-[13px] font-semibold text-app-text">
            {totalMemMB !== null ? `${totalMemMB} MB` : '-'}
          </span>
        </div>

        {/* DUE tessere e non cinque: «l'app che guardi» e «il lavoro che gira
            per conto tuo» sono le uniche due meta' che si possono CHIUDERE in
            modo diverso - una chiudendo pannelli, l'altra fermando sessioni.
            Renderer/GPU/altro erano tre numeri che nessuno poteva agire. */}
        <div className="grid grid-cols-2 gap-1.5">
          <PerfStat
            label={tr('perf.tileApp')}
            value={mem ? `${mem.totalMB}MB` : tr('perf.na')}
            color={perf && (perf.cpu.total ?? 0) > 50 ? 'text-amber-500' : undefined}
            title={isPartial ? tr('perf.shellRssTitle') : tr('perf.tileAppTitle')}
          />
          <PerfStat
            label={tr('perf.tileAgents', { n: serverSideProcs })}
            value={serverSideMemMB !== null ? `${serverSideMemMB}MB` : tr('perf.na')}
            color={fleet && fleet.cpuPercent > 50 ? 'text-amber-500' : undefined}
            title={serverSideTitle}
          />
        </div>

        {/* QUALE sessione tiene la memoria: e' l'unica riga di dettaglio che
            resta a vista, perche' e' l'unica su cui si puo' AGIRE (chiudere
            quella sessione). Tre e non tutte. */}
        {fleet && fleet.sessions.length > 0 && (
          <div data-testid="perf-sessions" className="flex flex-col gap-0.5 px-0.5 text-[10px] text-app-text-muted">
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
      </div>

      {/* 3 · C'E' QUALCOSA CHE NON VA? Parla SOLO quando c'e' un problema.
          Il caso buono e' gia' detto dagli fps qui sopra: una riga «tutto bene»
          e' una riga che si impara a saltare, e il giorno che dice altro non la
          legge piu' nessuno.
          I TOP PROCESSI DEL COMPUTER SONO STATI TOLTI: rispondevano a «cosa sta
          usando il Mac», che e' la domanda di Monitoraggio Attivita' e non di
          questo pannello. Elencavano processi di altre app su cui Topics non
          puo' fare niente, e occupavano cinque righe su nove. */}
      {(verdict || accelerated === false) && (
        <div data-testid="perf-verdict" className="space-y-0.5 pt-0.5">
          {accelerated === false && (
            <div className="flex items-center gap-1.5 px-1.5 py-1 rounded text-[10px]">
              <Cpu size={11} className="text-red-500" />
              <span className="text-app-text-muted">{tr('perf.softwareRendering')}</span>
              <span className="text-red-500 font-medium ml-auto">{tr('perf.noGpu')}</span>
            </div>
          )}
          {verdict && (
            <div className={`px-1.5 py-0.5 text-[10px] font-medium ${verdict.color}`}>{verdict.text}</div>
          )}
        </div>
      )}
    </div>
  );
}
