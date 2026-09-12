import { useEffect, useMemo } from 'react';
import { Activity, HardDrive } from 'lucide-react';
import { useFps, useFpsHistory, type FpsSample } from '@/lib/fpsMonitor';
import { formatCpuPercent, usePerfMetrics } from '@/hooks/usePerfMetrics';
import { useSystemStatus } from '@/hooks/useSystemStatus';
import { computeTopicsFootprint } from '@/lib/topicsFootprint';
import { scegliVerdetto } from './verdict';
import { useFeatureWeights } from '@/hooks/useFeatureWeights';
import { vociPerNatura, quantitaBreve, rigaVoce } from '@/lib/featureWeightText';
import { webviewSnapshot, ensurePaneUsageFresh } from '@/lib/paneUsage';
import { useT } from '@/hooks/useT';
import { useTopics } from '@/contexts/TopicsContext';
import { formatMemoryMB } from '@/lib/formatMemory';

/**
 * HOW EACH MEASURED ROW STANDS AGAINST THE TOTAL WRITTEN ABOVE IT.
 *
 * These rows are megabytes and they read like a column you can add up. They do
 * not add up, and nothing said so: the sessions are measured INSIDE the
 * terminal bridge (their pids are its descendants and the bridge's walk counts
 * them, `fleet-usage.ts`), the browser panes are webviews of the shell and so
 * are inside «L'app», and the agents' scripts are a third axis that
 * `computeTopicsFootprint` never adds to `totalMB` at all. Three rows of MB
 * that a reader sums by eye, arriving at a number that is not the one written
 * on the line above.
 *
 * It is written on the ROW and not in the label because the labels
 * (`featureUsage.ts`) are the names of the things; this is their relation to a
 * number that lives in another component, and it is translated, which the
 * labels are not yet.
 */
const SCOPE_NOTE: Record<string, string> = {
  'fleet.root.pty-bridge': 'perf.inventory.includesSessions',
  'fleet.sessions': 'perf.inventory.insideBridge',
  'shell.browserPanes': 'perf.inventory.insideApp',
  'fleet.scripts': 'perf.inventory.outsideTotal',
};

/** The per-project rows are built at read time (one id per path), so they are
 *  matched by prefix. They are sessions, so they sit inside the bridge exactly
 *  like the row they were split out of. */
function scopeNote(id: string): string | undefined {
  if (id.startsWith('fleet.project.')) return 'perf.inventory.insideBridge';
  return SCOPE_NOTE[id];
}

const SPARK_W = 288;
const SPARK_H = 40;

function fpsColor(fps: number): string {
  if (fps <= 0) return 'text-app-text-muted';
  if (fps < 30) return 'text-red-500';
  if (fps < 50) return 'text-amber-500';
  return 'text-emerald-500';
}

function FpsSparkline({ data, sampling }: { data: FpsSample[]; sampling: string }) {
  if (data.length < 2) {
    return (
      <div
        className="rounded bg-elevated flex items-center justify-center text-micro text-app-text-muted"
        style={{ height: SPARK_H }}
      >
        {sampling}
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

function PerfStat({ label, value, sub, color, title, className }: { label: string; value: string; sub?: string | null; color?: string; title?: string; className?: string }) {
  // Width is controlled by the parent grid (col-span) so the CPU row and the
  // Memory row share the same 4-column rhythm and line up vertically.
  // `sub` e' la percentuale della meta': il totale sta nella riga sopra, qui c'e'
  // da dove viene - ed e' il dettaglio per gruppo che l'anteprima non mostra.
  return (
    <div className={`flex flex-col items-center gap-0.5 px-2 py-1 rounded bg-elevated ${className ?? ''}`} title={title}>
      <span className="text-nano uppercase tracking-wide text-app-text-muted">{label}</span>
      <span className={`text-mini font-medium tabular-nums ${color ?? 'text-app-text'}`}>{value}</span>
      {sub && <span className="text-nano tabular-nums text-app-text-muted">{sub}</span>}
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
  // WHICH FOLDERS ARE PROJECTS, from the topics that name one. The server can
  // attribute a session to a working directory, and a working directory is not
  // a project just because something runs in it: measured on the live machine,
  // four shells in $HOME hold 1.3 GB and would invent a project out of the home
  // folder. Only a path this installation already treats as a project is
  // allowed to stand in - see `progettiNoti` in `featureUsage.ts`.
  const topics = useTopics();
  const knownProjects = useMemo(() => {
    const paths = new Set<string>();
    for (const id in topics) {
      const p = topics[id]?.projectPath;
      if (p) paths.add(p);
    }
    return paths;
  }, [topics]);
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
  // È LO STESSO che usa l'anteprima nella barra di stato (SidebarStatusBar), ed
  // è il motivo per cui le due superfici non possono più dire numeri diversi.
  const footprint = computeTopicsFootprint({
    deviceMB: mem?.totalMB ?? null,
    deviceProcessCount: mem?.processCount ?? 0,
    devicePartial: isPartial,
    deviceCpu: perf?.cpu.total ?? null,
    serverMB: fleet?.memoryMB ?? status?.server.memoryMB ?? null,
    serverProcessCount: fleet?.processCount ?? (status?.server ? 1 : 0),
    serverMetric: fleet?.memMetric ?? 'rss',
    serverCpu: fleet?.cpuPercent ?? null,
    scriptsMB: fleet?.scriptsMB ?? 0,
    scriptsProcessCount: fleet?.scriptsProcessCount ?? 0,
    sampleKey: status?.timestamp,
  });

  const totalMemMB = footprint.totalMB;
  const serverSideMemMB = footprint.serverMB;
  const serverSideProcs = footprint.serverProcessCount;
  // THE TILDE LEFT THE NUMBER. It meant "this total covers one half of the app"
  // (a phone, or a device reading that only sees the shell) and it was the one
  // abbreviation on the panel that the panel never explained: the legend lives
  // in another surface's tooltip. A `~` glued to a digit reads as a typo. The
  // fact is still declared, in words, next to the process count above - see
  // `perf.partialReading`.

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
  //
  // La DECISIONE sta in `scegliVerdetto` (verdict.ts), pura e provata; qui
  // resta solo la traduzione e il colore. Prima viveva in linea, e una regola
  // che si puo' leggere solo montando un componente non ha modo di essere
  // sbagliata rumorosamente.
  const scelta = scegliVerdetto({
    accelerated: perf ? (accelerated ?? null) : null,
    compressedMB: isPartial ? null : compressedMB,
    totalMB: mem && !isPartial ? mem.totalMB : null,
    residentMB: mem && !isPartial ? mem.residentMB : null,
    totalCpu: footprint.totalCpu,
  });
  const verdict: { text: string; color: string } | null =
    scelta === null ? null
    : scelta.tipo === 'noAccel' ? { text: tr('perf.verdict.noAccel'), color: 'text-red-500' }
    : scelta.tipo === 'compressed' ? { text: tr('perf.verdict.compressed', { gb: scelta.gb }), color: 'text-amber-500' }
    : scelta.tipo === 'mostlySwapped' ? { text: tr('perf.verdict.mostlySwapped', { pct: scelta.pct, mb: scelta.mb }), color: 'text-app-text-muted' }
    : { text: tr('perf.verdict.loaded'), color: 'text-amber-500' };

  // No "Fluido" line in the good case: the FPS headline + sparkline above
  // already say it. The verdict only speaks up when there's a real problem.

  /* L'INVENTARIO. Sempre attivo qui — a differenza della barra, dove si accende
   * col mouse: questo pannello e' montato SOLO mentre il dropdown e' aperto,
   * quindi «montato» e «qualcuno sta guardando» sono la stessa cosa. E' la
   * stessa ragione per cui il poll qui e' a 3s e in barra a 60. */
  useEffect(() => { ensurePaneUsageFresh(); }, [status?.timestamp]);
  const vociPeso = useFeatureWeights(true, {
    sessioni: fleet?.sessions ?? [],
    browser: webviewSnapshot(),
    radici: fleet?.roots ?? [],
    scriptsMB: fleet?.scriptsMB ?? 0,
    scriptsProcessCount: fleet?.scriptsProcessCount ?? 0,
    knownProjects,
  }, status?.timestamp);
  const measuredVisibleEntries = vociPerNatura(vociPeso, 'misurato');
  const vociTrattenuteVisibili = vociPerNatura(vociPeso, 'trattenuto');

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
          <span className="flex items-center gap-1.5 text-mini text-app-text-muted">
            <Activity size={12} /> {tr('perf.q1')}
          </span>
          <span className="flex items-baseline gap-2 tabular-nums">
            <span className={`text-title font-semibold leading-none ${fpsColor(fps)}`}>{fps || '-'}</span>
            <span className="text-micro text-app-text-muted">{tr('perf.fpsAvg', { n: avg || '-' })}</span>
          </span>
        </div>
        <FpsSparkline data={history} sampling={tr('perf.sampling')} />
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
            footprint.deviceCpu !== null ? tr('perf.cpuInline', { pct: formatCpuPercent(footprint.deviceCpu) }) : null,
            footprint.serverCpu !== null ? tr('perf.cpuServerInline', { pct: formatCpuPercent(footprint.serverCpu) }) : null,
          ].filter(Boolean).join('\n')}
        >
          <span className="flex items-center gap-1.5 text-mini text-app-text-muted">
            <HardDrive size={12} /> {tr('perf.q2')}
            {/* TEN PIXELS AND A TOKEN, not nine and an opacity. `opacity-60`
                on `--text-muted` measures 2.30:1 in light and 2.52:1 in dark,
                against the 4.5:1 that token was tuned for - and tuned at
                11-12px. This line and the inventory heading below were the two
                least readable texts on a panel whose whole job is to be read.
                `--text-faint` is the token that exists for a second rank. */}
            <span className="text-micro text-app-text-faint">
              {tr('perf.procCount', { n: footprint.totalProcessCount })}
              {footprint.memPartial || footprint.cpuPartial
                ? ` \u00b7 ${tr('perf.partialReading')}`
                : ''}
            </span>
          </span>
          {/* I CONTEGGI TOTALI COMPLESSIVI: memoria E percentuale dell'insieme,
              non di una meta'. La CPU sparisce quando non e' misurata: uno «0%»
              li' sembra una misura ed e' invece l'assenza di misura. */}
          <span className="flex items-baseline gap-2">
            <span className="tabular-nums text-prose font-semibold text-app-text">
              {totalMemMB !== null ? formatMemoryMB(totalMemMB) : '-'}
            </span>
            {footprint.totalCpu !== null && (
              <span className="tabular-nums text-mini font-medium text-app-text-muted">
                {tr('perf.cpuTotal', { pct: formatCpuPercent(footprint.totalCpu) })}
              </span>
            )}
          </span>
        </div>

        {/* DUE tessere e non cinque: «l'app che guardi» e «il lavoro che gira
            per conto tuo» sono le uniche due meta' che si possono CHIUDERE in
            modo diverso - una chiudendo pannelli, l'altra fermando sessioni.
            Renderer/GPU/altro erano tre numeri che nessuno poteva agire. */}
        <div className="grid grid-cols-2 gap-1.5">
          <PerfStat
            label={tr('perf.tileApp')}
            value={mem ? formatMemoryMB(mem.totalMB) : tr('perf.na')}
            sub={footprint.deviceCpu !== null ? tr('perf.cpuTotal', { pct: formatCpuPercent(footprint.deviceCpu) }) : null}
            color={(footprint.deviceCpu ?? 0) > 50 ? 'text-amber-500' : undefined}
            title={isPartial ? tr('perf.shellRssTitle') : tr('perf.tileAppTitle')}
          />
          <PerfStat
            label={tr('perf.tileAgents', { n: serverSideProcs })}
            value={serverSideMemMB !== null ? formatMemoryMB(serverSideMemMB) : tr('perf.na')}
            sub={footprint.serverCpu !== null ? tr('perf.cpuTotal', { pct: formatCpuPercent(footprint.serverCpu) }) : null}
            color={(footprint.serverCpu ?? 0) > 50 ? 'text-amber-500' : undefined}
            title={serverSideTitle}
          />
        </div>

        {/* 3 - IS ANYTHING WRONG? It speaks ONLY when there is a problem. The
            good case is already said by the fps above: a line reading "all
            fine" is a line you learn to skip, and on the day it says something
            else nobody reads it any more.

            IT SITS HERE, ABOVE THE INVENTORY, and not at the foot of the panel.
            It is the one line that speaks when something is broken, and down
            there it could land under as many as fifteen inventory rows, inside
            a container that scrolls and that shares 560px with the agent list:
            in the case where it is needed, it was off the screen. An alarm you
            reach by scrolling is not an alarm.

            THE «Rendering software / no GPU» ROW IS GONE: it was unreachable
            (acceleration arrives hardwired to `true`, and outside Tauri the
            metrics are null), and had it ever lit up it would have said the
            same thing as the verdict under it. It spent a row of the panel's
            tightest block in order never to appear. */}
        {verdict && (
          <div data-testid="perf-verdict" className={`px-1.5 py-0.5 text-micro font-medium ${verdict.color}`}>
            {verdict.text}
          </div>
        )}

        {/* COSA TIENE QUEL NUMERO — l'inventario per funzionalita'.
            Prende il posto della vecchia riga «le tre sessioni piu' pesanti»,
            che rispondeva alla stessa domanda ma per UNA sola categoria: le
            sessioni erano le uniche a comparire, quindi un pannello browser da
            440 MB o cinquanta task caricati non si vedevano da nessuna parte.
            Adesso le sessioni restano (in cima, perche' l'ordinamento mette il
            misurato davanti) e accanto compare tutto il resto.

            DUE NATURE, MAI SOMMATE: sopra i MB veri, sotto i conteggi. Non c'e'
            un totale che le comprenda, e non e' una dimenticanza — lo stato JS
            di una funzionalita' non e' dove sta il suo peso (misurato: 0,2 MB
            dichiarati contro 440 nel renderer), quindi convertirlo in MB per
            poterlo sommare sarebbe inventare il numero. Vedi `featureWeight.ts`. */}
        {vociPeso.length > 0 && (
          <div data-testid="perf-inventory" className="flex flex-col gap-0.5 px-0.5 text-micro text-app-text-muted">
            {measuredVisibleEntries.map(v => (
              <div key={v.id} data-testid="perf-inventory-row" className="flex items-center justify-between gap-2" title={rigaVoce(v)}>
                <span className="min-w-0 truncate">
                  {v.labelKey ? tr(v.labelKey) : v.label}
                  {scopeNote(v.id) && (
                    <span className="text-app-text-faint"> {tr(scopeNote(v.id)!)}</span>
                  )}
                </span>
                <span className="tabular-nums whitespace-nowrap text-app-text">
                  {v.errore ? tr('perf.inventory.unmeasured') : formatMemoryMB(v.peso.memoryMB ?? 0)}
                </span>
              </div>
            ))}
            {vociTrattenuteVisibili.length > 0 && (
              <>
                {/* L'intestazione compare SOLO se sotto c'e' qualcosa, e dice
                    perche' quei numeri non sono in MB: senza, due colonne
                    diverse una sopra l'altra si leggono come la stessa cosa. */}
                <div className="pt-1 text-micro uppercase tracking-wide text-app-text-faint">
                  {tr('perf.inventory.heldHeading')}
                </div>
                {vociTrattenuteVisibili.map(v => (
                  <div key={v.id} data-testid="perf-inventory-row" className="flex items-center justify-between gap-2" title={rigaVoce(v)}>
                    <span className="truncate">{v.label}</span>
                    <span className="tabular-nums whitespace-nowrap text-app-text">
                      {v.errore ? tr('perf.inventory.unmeasured') : quantitaBreve(v)}
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>

    </div>
  );
}
