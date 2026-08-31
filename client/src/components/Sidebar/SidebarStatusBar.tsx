import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Wifi, RefreshCw, RotateCcw } from 'lucide-react';
import { createPortal } from 'react-dom';
import { reloadAllWindows } from '@/lib/shell/app';
import { useSystemStatus } from '@/hooks/useSystemStatus';
import { useServiceWorkerUpdate } from '@/hooks/useServiceWorkerUpdate';
import { useOpenClawAvailable } from '@/hooks/useOpenClawAvailable';
import { useDismissable } from '@/hooks/useDismissable';
import { POPOVER_MARGIN, POPOVER_PANEL, Z_POPOVER } from '@/lib/popoverStyles';
import { useFps, useFpsActive } from '@/lib/fpsMonitor';
import { formatCpuPercent, usePerfMetrics } from '@/hooks/usePerfMetrics';
import { PerfSection } from './PerfSection';
import { computeTopicsFootprint } from '@/lib/topicsFootprint';
import { mostraResidenteInBarra } from './verdict';
import { IdentityBlock } from './IdentityBlock';
import { SEGNALE_OK, SEGNALE_ATTESA, SEGNALE_GUASTO, PALLINO_OK, PALLINO_ATTESA, PALLINO_GUASTO } from './chromeSignals';
import { ensurePaneUsageFresh, webviewSnapshot } from '@/lib/paneUsage';
import { useFeatureWeights } from '@/hooks/useFeatureWeights';
import { bloccoTooltip } from '@/lib/featureWeightText';
import { VersionPopover } from './VersionPopover';
import { bundleDrift } from './bundleDrift';
import { VersionChip } from './VersionChip';
import { ChangelogModal } from '../ChangelogModal';
import type { ConnectionStatus } from '@/types';
import { ROW_INSET, SIDEBAR_ACTIVE, SIDEBAR_HOVER } from '@/lib/selectionStyles';
import { isDesktop } from '@/lib/shell';
import { clearBootDegraded, degradedNotice, fetchBootDegraded, type BootDegraded } from '@/lib/shell/bootDegraded';
import { getVersion, relaunch } from '@/lib/shell/app';
import { useMobile } from '@/hooks/useMobile';
import { useT } from '@/hooks/useT';
import { computeMenuPosition } from '../../lib/popoverPosition';

declare const __BUILD_TIME__: string;
declare const __BUILD_SHA__: string;
declare const __APP_VERSION__: string;

// Versione compilata a build time da client/vite.config.ts (define
// `__APP_VERSION__`, letta dal package.json di ROOT). Nell'app desktop si
// preferisce `getVersion()` di lib/shell/app a runtime, perché un auto-update
// può cambiarla dopo la build di questo bundle.
const BUILD_APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '';

// When this bundle was compiled (`vite build`). In dev the "X fa" chip tracks
// live HMR and means "last code change"; in prod that branch is dead code, so
// the value is just the build timestamp — showing it as "ultimo aggiornamento
// codice" is misleading. In prod we drop the relative chip and surface this as
// an absolute build date in the version tooltip instead.
const BUILD_TIME = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '';
const BUILD_SHA = typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : '';

// Le tinte dei tre segnali stanno in `chromeSignals.ts`: le legge anche il
// blocco dell'identita' qui sopra la barra, e due copie tarate a mano sullo
// stesso chrome sono due copie che divergono alla prima ritaratura.

function formatBuildDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' });
  } catch { return iso; }
}

// Fabbrica condivisa fra il prefetch (hover sul trigger) e il confine `lazy()`
// più in basso, così risolvono lo STESSO modulo — stesso motivo per cui App.tsx
// ha `importCommandPalette`. La destrutturazione dentro l'`await` è anche
// l'unica forma in cui il cancello sul codice morto vede quali export usi: con
// un `import()` opaco nessun export di questo modulo può più risultare morto
// (`bun run check:deadcode-blindspots`).
const importSystemStatusPanel = async () => {
  const { SystemStatusPanel: Component } = await import('./SystemStatusPanel');
  return { default: Component };
};

// Prefetch the lazy status panel chunk so the dropdown opens instantly instead
// of flashing a "Loading…" while the chunk downloads on first click. Triggered
// on hover/focus of the trigger button. Vite dedupes with the lazy() import().
let _statusPanelPrefetched = false;
function prefetchStatusPanel() {
  if (_statusPanelPrefetched) return;
  _statusPanelPrefetched = true;
  importSystemStatusPanel().catch(() => { _statusPanelPrefetched = false; });
}

// Track last code update time — updates on HMR in dev, uses __BUILD_TIME__ in prod
let _lastUpdateTime = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : new Date().toISOString();
if (import.meta.env.DEV) {
  _lastUpdateTime = new Date().toISOString();
  // Listen for ANY HMR update via Vite's WebSocket (not just this module)
  try {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const hmrWs = new WebSocket(`${protocol}://${location.host}`, 'vite-hmr');
    hmrWs.addEventListener('message', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'update') {
          _lastUpdateTime = new Date().toISOString();
          window.dispatchEvent(new CustomEvent('hmr-update'));
        }
      } catch {}
    });
  } catch {}
}

function useLastChangeTime(): string {
  const [time, setTime] = useState(_lastUpdateTime);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const handler = () => setTime(new Date().toISOString());
    window.addEventListener('hmr-update', handler);
    return () => window.removeEventListener('hmr-update', handler);
  }, []);
  return time;
}

function formatBuildTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'now';
    if (diffMin < 60) return `${diffMin}m`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h`;
    const diffD = Math.floor(diffH / 24);
    return `${diffD}d`;
  } catch { return iso; }
}

const SystemStatusPanel = lazy(importSystemStatusPanel);

/** Typical height of the status panel: it only picks the SIDE before the panel
 *  is measured. Getting it slightly wrong costs a generous `maxHeight`, never a
 *  panel off screen — the clamp keeps it inside either way. */
const STATUS_PANEL_H_ESTIMATE = 420;

export function SidebarStatusBar({ wsStatus, dataNotice, onOpenDevices, variant = 'column', onOpenChangelog }: {
  wsStatus?: ConnectionStatus;
  dataNotice?: string | null;
  /**
   * WHERE THIS IS BEING DRAWN, because the two halves went to two places on
   * 2026-08-31 (SIDEBAR-STATUS-01).
   *
   * `menu` — the machine's state (connection, memory, CPU, version, restart,
   * the degraded-boot notice) moved inside the «Topics» dropdown, which is
   * where it was asked for and where the phone has had it since 07/08.
   *
   * `column` — the identity band did NOT follow it, and that is deliberate. Its
   * contract is RESPONSIVE: `identity-chips.spec.ts` measures the three
   * subjects holding one line at sidebar widths 180, 256 and 400, and the
   * desktop dropdown is `min-w-[200px]` and does not track the column. Moving
   * it in would not have relocated the band, it would have deleted the contract
   * that band was built to satisfy. It also keeps the accounts where a person
   * already looks for them, which is the half that sent this bar back to the
   * foot on 07/08 in the first place.
   */
  variant?: 'column' | 'menu';
  /**
   * Who owns the changelog modal. Without it the bar owns it itself — right at
   * the foot of a column, wrong inside a menu: a modal parented to a component
   * that lives in a scrolling dropdown is clipped by it, and it unmounts with
   * the dropdown the moment anything closes it. Passing this hands the modal to
   * App, which is what the phone's menu has always done.
   */
  onOpenChangelog?: (version: string) => void;
  /** Apre Impostazioni → Account. La riga dell'identità è il punto da cui si
   *  arriva ai dispositivi: chi si chiede «chi sono qui?» si chiede subito dopo
   *  «e chi altro?», e farglielo cercare in un pannello è farlo cercare. */
  onOpenDevices?: () => void;
} = {}) {
  const tr = useT();
  // Serve solo a scegliere il glifo del gruppo «dispositivo»: chi legge deve
  // riconoscere a colpo d'occhio che quei numeri sono di QUESTO coso qui.
  const { isMobile } = useMobile();
  // Slow polling for the status bar (60s)
  const { status, refresh: refreshStatus } = useSystemStatus(true, 60000);
  const openclawAvailable = useOpenClawAvailable();
  const gatewayOnline = status?.gateway.online ?? false;
  const lastChangeTime = useLastChangeTime();
  // Shared FPS monitor: idle burst-sampling for this number, live 1Hz while the
  // dropdown is open (see useFpsActive below).
  const fps = useFps();
  // Shell-process memory + CPU (Tauri). The hook self-guards (null in web mode,
  // pauses while the window is hidden), so an always-on 5s poll is cheap. NOTE:
  // this is the SHELL process only — `perf.partial` is true because the WKWebView
  // content/GPU processes (the per-pane browser RAM) are reparented to launchd and
  // can't be attributed, so it is labeled honestly as the shell figure below.
  const perf = usePerfMetrics(true, 5000);
  const { updateAvailable } = useServiceWorkerUpdate();
  const [refreshing, setRefreshing] = useState(false);

  // Desktop (Tauri) gates the relaunch button + the live-version override; these
  // route through the shell bridge (relaunch()/getVersion()).
  const isDev = import.meta.env.DEV;
  // "Last local update" chip. Show it in dev (HMR-tracked) AND when this build
  // is RECENT — the desktop app runs the BUILT bundle (import.meta.env.DEV is
  // false) even while developing locally, so a fresh `vite build` is the only
  // signal that a local change landed. A genuinely shipped release is >24h old,
  // so the chip auto-hides there instead of being a meaningless ever-growing
  // counter (the earlier "30s fa che non è vero" complaint).
  // The headline is the WHOLE app: shell + every WKWebView process macOS
  // attributes to it, the same set (and the same footprint metric) Activity
  // Monitor groups under "Topics". It used to be the shell process alone —
  // measured, that read 59 MB while the app really held 6937 MB across 24
  // processes, so the one number the status bar exists to show was off by ~100x.
  // `perf.partial` still guards platforms with no attribution API.
  const serverMemMB = status?.server.memoryMB ?? null;
  // Optional-chain `memory`: it crosses the IPC boundary, so a renderer running
  // ahead of a not-yet-rebuilt shell (auto-update / partial deploy) can see an old
  // payload without `memory`. `?.memory?.` degrades to the server-only fallback
  // instead of throwing. Every read below is gated on appMemMB, so a non-null
  // value guarantees perf.memory exists.
  const memMetric = perf?.memory?.metric;
  const isPartialMem = perf?.partial ?? false;
  const appMemMB = perf?.memory?.totalMB ?? null;
  const residentMemMB = perf?.memory?.residentMB ?? null;
  const procCount = perf?.memory?.processCount ?? null;
  // L'ALTRA metà di "Topics": il server e tutto ciò che guida — il pty-bridge
  // detached col suo albero di CLI `claude`, server MCP e Chrome headless,
  // l'ai-bridge, il sidecar WebRTC. L'insieme attribuito alla shell non li vede
  // (sono figli reparentati a launchd del SERVER), e la barra mostrava solo l'RSS
  // del processo Bun: misurato, ~100 MB contro ~4,3 GB davvero tenuti su 32
  // processi. Ricade sul numero a processo singolo dove `ps` non è usabile.
  const fleet = status?.server.fleet;
  const serverSideMemMB = fleet?.memoryMB ?? serverMemMB;
  /**
   * UN TOTALE IN ANTEPRIMA, LE DUE META' QUANDO APRI.
   *
   * L'08/08 questa riga era diventata DUE letture affiancate — «l'utilizzo del
   * dispositivo che sto usando» e «l'utilizzo del server» — per una ragione che
   * resta vera: sul telefono `usePerfMetrics` è `null` (il browser non espone i
   * processi), quindi una somma degenera nel SOLO lato server, cioè mostra la
   * RAM del Mac con l'etichetta «questo dispositivo».
   *
   * La richiesta più recente supera quella forma ma non cancella il problema:
   * in anteprima si vuole UNA cifra di memoria e UNA percentuale, non due di
   * ciascuna. Le tre cose stanno insieme così:
   *
   *  · in anteprima il totale complessivo, memoria e CPU, calcolati dallo
   *    stesso `computeTopicsFootprint` che usa il pannello Performance — una
   *    superficie sola, un calcolatore solo;
   *  · quando una delle due metà non è misurabile il totale si DICHIARA
   *    parziale (il segno «~» e il tooltip che dice cosa manca), invece di
   *    spacciare una metà per il tutto;
   *  · il dettaglio per gruppo non sparisce: sta nel tooltip qui e nelle due
   *    tessere del pannello Performance, che è «quando apri».
   *
   * Le due metà usano la STESSA metrica (`phys_footprint`, quella di
   * Monitoraggio Attività), quindi la somma è omogenea: prima il lato server
   * sommava `ps rss` e unire le due unità non aveva senso — misurato, 2,07 GB
   * di rss contro 1,17 di footprint sullo stesso albero. `memMetric` resta
   * detto nel tooltip: su una piattaforma senza `proc_pid_rusage` si ripiega su
   * rss, e va detto invece che nascosto.
   */
  const fmtMB = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${mb}MB`);
  /**
   * LE DUE SOGLIE, che adesso si sommano in una sola.
   *
   * Dispositivo: >3 GB per l'app intera, molto più basso (1 GB) per una lettura
   * parziale che copre la sola shell.
   *
   * Server: 6 GB, e NON 512 MB — quella era una correzione, non una taratura.
   * Prima la riga era `appMemMB !== null ? … : serverSide > 512`: sul telefono
   * `appMemMB` è sempre `null`, quindi la condizione ricadeva su quel ramo, e il
   * lato server sta normalmente sui 4 GB. Risultato: sul telefono il numero
   * della memoria era **sempre** in ambra, cioè un allarme perenne, che è lo
   * stesso che nessun allarme. 6 GB sta sopra il normale misurato (~4,3 GB su 32
   * processi) e sotto il patologico (14 GB di WKWebView orfane dopo una raffica
   * di ⌘R), quindi si accende quando c'è davvero qualcosa da guardare.
   */
  const THRESHOLD_DEVICE_MB = isPartialMem ? 1024 : 3072;
  const THRESHOLD_SERVER_MB = 6144;
  // La CPU segue lo stesso taglio della memoria: `null` = non misurata, che non
  // è zero (una pane appena aperta non ha ancora un delta).
  const shellCpu = perf?.cpu.total ?? null;
  const fleetCpu = fleet?.cpuPercent ?? null;

  // IL CALCOLATORE UNICO, lo stesso del pannello Performance. Qui serve solo il
  // totale: le due metà restano nei tooltip qui sotto.
  const usage = computeTopicsFootprint({
    deviceMB: appMemMB,
    deviceProcessCount: procCount ?? 0,
    devicePartial: isPartialMem,
    deviceCpu: shellCpu,
    serverMB: serverSideMemMB,
    serverProcessCount: fleet?.processCount ?? (serverMemMB !== null ? 1 : 0),
    serverMetric: fleet?.memMetric ?? 'rss',
    serverCpu: fleetCpu,
    scriptsMB: fleet?.scriptsMB ?? 0,
    scriptsProcessCount: fleet?.scriptsProcessCount ?? 0,
    sampleKey: status?.timestamp,
  });
  // La soglia del totale è la SOMMA delle due soglie già tarate qui sopra, e
  // solo per le metà che stanno davvero nel numero: sul telefono il totale è il
  // solo lato server, quindi la soglia torna quella del server e non si accende
  // un allarme perenne (era esattamente il bug del ramo `appMemMB !== null`).
  const thresholdTotal = (appMemMB !== null ? THRESHOLD_DEVICE_MB : 0)
    + (usage.serverMB !== null ? THRESHOLD_SERVER_MB : 0);
  const totalMemHigh = usage.totalMB !== null && usage.totalMB > thresholdTotal;
  const totalCpuHigh = usage.totalCpu !== null && usage.totalCpu > 50;
  /** Il «~» dice che il totale copre una metà sola: senza, un numero parziale
   *  si legge come il totale, ed è la ragione per cui le due letture erano state
   *  separate. Con lui possono tornare una. */
  const partialSign = (parziale: boolean) => (parziale ? '~' : '');

  /** QUESTO dispositivo: la shell e i suoi processi, più gli fps, che sono
   *  l'unica misura presa DI QUA anche quando non c'è nessuna shell. */
  const deviceTitle = [
    isMobile ? 'Questo telefono' : 'Questo computer',
    appMemMB !== null
      ? (isPartialMem
          ? `Topics (processo shell): ${appMemMB} MB di ${memMetric === 'footprint' ? 'footprint' : 'memoria residente (RSS)'}\n· NON include i processi WKWebView (contenuto browser dei pannelli)`
          : `Topics, ${procCount ?? '?'} processi: ${appMemMB} MB di footprint, lo stesso valore di Monitoraggio Attività\n· di cui in RAM adesso: ${residentMemMB ?? '-'} MB (il resto è compresso o in swap)`)
      : 'memoria e CPU non misurabili qui: il browser non espone i processi. Sono disponibili solo dentro l’app desktop.',
    shellCpu !== null
      ? `CPU: ${formatCpuPercent(shellCpu)}% della macchina`
      : null,
    perf && perf.cpu.pids > 0 && perf.cpu.sampled < perf.cpu.pids
      ? `misurata su ${perf.cpu.sampled}/${perf.cpu.pids} processi · gli altri non hanno ancora un delta`
      : null,
    fps > 0 ? `${fps} fotogrammi al secondo, misurati in questa finestra` : null,
  ].filter(Boolean).join('\n· ');

  /** IL SERVER: il Mac che regge Topics, con tutto ciò che guida — pty-bridge,
   *  CLI `claude`, server MCP, Chrome headless, ai-bridge, sidecar WebRTC. È
   *  sempre la STESSA macchina, che tu stia guardando dal telefono o da qui. */
  const serverTitle = [
    'Il server',
    fleet
      ? `${fleet.processCount} processi: ${fleet.memoryMB} MB`
        + (fleet.memMetric === 'footprint' ? ' di footprint' : fleet.memMetric === 'mixed' ? ' (footprint parziale)' : ' (RSS, stima alta)')
      : `processo Bun: ${serverMemMB ?? '-'} MB` + (status ? ` (heap ${status.server.heapUsedMB} MB)` : ''),
    fleetCpu !== null ? `CPU: ${formatCpuPercent(fleetCpu)}% della macchina` : 'CPU: non misurata',
    ...(fleet
      ? fleet.roots
          .filter(r => r.kind !== 'server' && r.memoryMB > 0)
          .map(r => `${r.kind}: ${r.memoryMB} MB, ${r.processCount} proc.`)
      : []),
  ].filter(Boolean).join('\n· ');

  /** IL TOTALE, e sotto da dove viene: il tooltip è il primo posto dove «aperto»
   *  vuol dire il dettaglio per gruppo, prima ancora del pannello Performance. */
  /**
   * QUANTA DI QUELLA MEMORIA E' DAVVERO OCCUPATA, detto sul numero che si legge
   * per primo.
   *
   * Il totale in barra e' `phys_footprint`, la colonna «Memoria» di
   * Monitoraggio Attivita': la scelta e' giusta e resta, ma include cio' che il
   * sistema ha gia' compresso o mandato in swap. Misurato il 2026-08-20 sulla
   * finestra dell'utente: **1.989 MB dichiarati contro 594 residenti**, cioe'
   * l'80% gia' ceduto — e la riga che lo spiegava viveva solo nel pannello
   * Performance, due clic piu' in la'. Chi legge «1,8 GB» sulla barra e non
   * apre niente resta con un numero che significa una cosa diversa da quella
   * che sembra.
   *
   * Si mostra solo quando la quota compressa e' sostanziale (meta' del totale,
   * con un pavimento di 300 MB): sotto, la riga sarebbe rumore su ogni avvio.
   */
  const showResident = mostraResidenteInBarra({
    totalMB: usage.totalMB, residentMB: residentMemMB,
    serverMB: serverSideMemMB, partial: isPartialMem,
  });

  /**
   * COSA TIENE QUEL NUMERO, sul numero stesso.
   *
   * La riga sopra dice quanta di quella memoria e' davvero occupata; questa dice
   * COSA la occupa. Sono le due meta' della stessa domanda, e finora nessuna
   * delle due viveva qui: la barra mostrava «1,8 GB» e basta.
   *
   * SI CALCOLA SOLO COL MOUSE SOPRA. `hoverTotale` si accende su
   * `mouseenter`/`focus` del gruppo: raccogliere l'inventario vuol dire
   * serializzare lo stato di mezza app, e farlo ogni cinque secondi con la
   * finestra ferma sarebbe lavoro a riposo per un testo che nessuno legge —
   * esattamente cio' che questa app ha appena finito di togliersi di dosso.
   * (RES-ATTR-04: la misura si chiede quando serve a qualcuno.)
   * This line used to cite RES-ATTR-08, which names something else entirely
   * in the reference document: see docs/archive/RILETTURA-14-REQUISITI-PROMOSSI.md.
   */
  const [hoverTotale, setHoverTotale] = useState(false);
  /* Accendere l'inventario CHIEDE anche un campione fresco.
   *
   * La barra ricampiona ogni 60 secondi: senza questa richiesta, chi passa il
   * mouse subito dopo un campione senza flotta (il server che riparte, il
   * primo giro dopo l'avvio) leggerebbe un elenco con le sole voci trattenute
   * per un minuto intero, cioe' l'inventario senza la meta' che pesa. Le due
   * chiamate sono deduplicate a valle — `ensurePaneUsageFresh` ha la sua
   * finestra di validita' e `refresh` e' una fetch sola. */
  const showInventory = useCallback(() => {
    setHoverTotale(true);
    ensurePaneUsageFresh();
    void refreshStatus();
  }, [refreshStatus]);
  const vociPeso = useFeatureWeights(hoverTotale, {
    sessioni: fleet?.sessions ?? [],
    browser: webviewSnapshot(),
    radici: fleet?.roots ?? [],
    scriptsMB: fleet?.scriptsMB ?? 0,
    scriptsProcessCount: fleet?.scriptsProcessCount ?? 0,
  }, status?.timestamp);
  const recapPeso = bloccoTooltip(vociPeso);

  const totalTitle = [
    'Topics in tutto',
    usage.totalMB !== null
      ? `memoria: ${partialSign(usage.memPartial)}${fmtMB(usage.totalMB)} su ${usage.totalProcessCount} processi`
      : 'memoria: non misurata',
    showResident ? tr('statusBar.residenteInline', { mb: residentMemMB ?? 0 }) : null,
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
    // L'inventario in CODA, non in testa: chi passa il mouse cerca prima il
    // totale e le due meta'. Il dettaglio di cosa lo compone e' la domanda
    // DOPO, e metterlo davanti spingerebbe giu' il numero che si cercava.
    + (recapPeso ? `\n\n${recapPeso}` : '');

  // Chip = the CLIENT bundle version actually running. It moves on EVERY deploy,
  // including client-only hot-deploys (the "chip che cresce = deploy atterrato"
  // signal). The native shell binary version is a SEPARATE fact, resolved via the
  // shell bridge and shown in the popover — never conflated here: overriding the
  // chip with the shell version made a freshly hot-deployed client read as the
  // OLD shell number, so a landed deploy looked like a no-op.
  // The BAKED __APP_VERSION__ is frozen at `vite build --watch` start, so after
  // a version bump the chip lies until the build-watch is kickstarted. Prefer
  // the runtime value from /api/version (the server re-reads package.json fresh)
  // and fall back to the baked one when the endpoint is unreachable (standalone
  // build with no live server). Truthful the moment the version is bumped.
  const [runtimeVersion, setRuntimeVersion] = useState('');
  useEffect(() => {
    let alive = true;
    fetch('/api/version', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then((d: { version?: string } | null) => {
        if (alive && d?.version) setRuntimeVersion(d.version);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const appVersion = runtimeVersion || BUILD_APP_VERSION;
  // Preferring the runtime number cured one lie and created its mirror: when
  // `public/` is older than the repo the chip reads the REPO version while the
  // screen runs the old bundle, and until now nothing said so. Both facts are
  // right here, so compare them (see bundleDrift.ts for the measured incident).
  const drift = bundleDrift(BUILD_APP_VERSION, runtimeVersion, { hmr: isDev });
  const [shellVersion, setShellVersion] = useState('');
  useEffect(() => {
    if (!isDesktop) return;
    getVersion().then(v => { if (v) setShellVersion(v); }).catch(() => {});
  }, []);
  // A DEVELOPMENT INSTALL IS A FACT ABOUT THE MACHINE, not about the build.
  //
  // `isDev` is the Vite dev server, always false in the desktop app, which runs
  // the built bundle. `devReload` is the server hot-delivering `public/`
  // (`topics-dev.json`), which is exactly the state the desktop machine that
  // builds Topics is in, and until now it was readable only by opening the
  // version popover. Reported: the person could not see they were in
  // development mode, and read the repo number as "I am up to date".
  const devInstall = isDev || !!status?.server?.devReload;

  const handleRefresh = async () => {
    // Immediate spin so the click is acknowledged (in Electron the app then
    // relaunches; in web we clear caches + hard-reload).
    setRefreshing(true);
    if (isDesktop) {
      // True process restart via the shell bridge (Electron app.relaunch / Tauri
      // process plugin). Falls through to the web cache-bust reload below if the
      // host can't relaunch, so the button is never inert.
      try { await relaunch(); return; } catch { /* fall through */ }
    }
    try {
      // Clear all caches
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      // Force SW update
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) {
        await reg.update();
        if (reg.waiting) reg.waiting.postMessage('SKIP_WAITING');
      }
    } catch {}
    // Hard reload (bypass cache) — su desktop TUTTE le finestre, vedi
    // reloadAllWindows.
    void reloadAllWindows();
  };

  const [showStatusDropdown, setShowStatusDropdown] = useState(false);
  const statusBtnRef = useRef<HTMLButtonElement>(null);
  const statusDropdownRef = useRef<HTMLDivElement>(null);

  // Version chip → info + auto-update popover.
  const [showVersionPopover, setShowVersionPopover] = useState(false);
  // The full "Novità" changelog modal, opened from the popover.
  const [showChangelog, setShowChangelog] = useState(false);
  // Anchor captured at click (not read from a ref during render) so the popover
  // positions against the live button without tripping react-hooks/refs.
  const [versionAnchor, setVersionAnchor] = useState<HTMLButtonElement | null>(null);
  // Tell the UpdaterToast the popover owns the update surface right now. Both
  // anchor to the SAME version chip, so a status change while the popover is
  // open (e.g. its own "Controlla aggiornamenti" flipping state) popped the
  // toast directly on top of it — two nested update cards (reported live
  // 2026-07-11). The toast suppresses itself while this reports open.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('topics:version-popover', { detail: { open: showVersionPopover } }));
    return () => {
      if (showVersionPopover) {
        window.dispatchEvent(new CustomEvent('topics:version-popover', { detail: { open: false } }));
      }
    };
  }, [showVersionPopover]);

  // While the dropdown is open, hold the FPS monitor in its live (continuous,
  // 1Hz) cadence so the sparkline updates in real time. It drops back to cheap
  // idle bursts when closed.
  useFpsActive(showStatusDropdown);

  // Close dropdown on outside pointer / Escape via the shared contract
  // (capture-phase pointerdown + touch + Escape, focus-restore). Trigger +
  // portalled panel both count as "inside". Bespoke bottom-anchored placement
  // below is preserved.
  useDismissable({
    open: showStatusDropdown,
    onClose: () => setShowStatusDropdown(false),
    refs: [statusBtnRef, statusDropdownRef],
    // Same reason as the version popover: in the `menu` variant this panel opens
    // from inside the «Topics» dropdown and lives in a portal, i.e. outside the
    // refs of whoever hosts it. Declaring itself a sub-surface is what stops its
    // own parent from closing under the click.
    exclusive: false,
  });

  /**
   * WHY THE SHELL'S BOOT VERDICT IS READ HERE, measured on Windows 2.2.199 on
   * 2026-08-28 (board card d1f702ab). When the `external-server-seen` marker says
   * this machine owns a real server on :3333 and nobody answers there, the shell
   * deliberately waits instead of forking an empty universe over a slow-but-alive
   * server (the 2026-08-13 incident). That rule stays. What was broken is that the
   * only thing on screen was this bar's red dot: the shell's explanation lives on
   * the reconnect page, which the proxy serves in place of a DOCUMENT navigation,
   * and the window loads its bundle from the app's own scheme, so nobody ever gets
   * there. The wait was total and mute, and the way out was a file nobody names.
   *
   * ASKED WHILE OFFLINE, not once at mount. Measured on that machine: the window
   * paints at about +5s and the shell's verdict lands at about +150s, so a single
   * question at mount is asked long before there is an answer and the explanation
   * never arrived. A yes is terminal and stops the asking; a connection stops it
   * too, because a connected app has nothing to explain. See `bootDegraded.ts`.
   */
  const [degraded, setDegraded] = useState<BootDegraded | null>(null);
  // Set only when the button failed: on success the process is replaced.
  const [degradedFixFailed, setDegradedFixFailed] = useState(false);
  const connected = wsStatus === 'connected';
  useEffect(() => {
    if (degraded || connected) return;
    let alive = true;
    const ask = () => {
      void fetchBootDegraded().then((d) => {
        if (alive && d) setDegraded(d);
      });
    };
    ask();
    const t = window.setInterval(ask, 5000);
    return () => { alive = false; window.clearInterval(t); };
  }, [degraded, connected]);
  const degradedLines = degradedNotice(degraded, wsStatus);

  // Close on sidebar collapse. The status bar lives inside the sidebar but the
  // dropdown is portaled to <body> (position:fixed), so when the (overlay)
  // sidebar slides away the dropdown stays floating over the content — "la
  // finestra degli fps restava anche da [sidebar] chiusa". The sidebar slide
  // dispatches `topics:sidebar-resize-start` (useSidebarFitCoalesce); dismiss on
  // it so the panel leaves with the sidebar. Harmless on expand (nothing open).
  useEffect(() => {
    if (!showStatusDropdown) return;
    const close = () => setShowStatusDropdown(false);
    window.addEventListener('topics:sidebar-resize-start', close);
    return () => window.removeEventListener('topics:sidebar-resize-start', close);
  }, [showStatusDropdown]);

  return (
    <>
      {/* IL BLOCCO DELL'IDENTITA', sopra la barra di stato: tre soggetti - io,
          i gruppi in cui sto, le persone che ho intorno. Il perche' di ciascuno
          sta in `IdentityBlock.tsx`; qui conta che sia SENZA BORDI e che questa
          barra abbia perso il suo `border-t`. Erano due fili grigi in trenta
          pixel di altezza, e tagliavano il fondo della colonna in tre fette che
          si leggevano come tre barre di applicazioni diverse: il fondo della
          sidebar e' UNA fascia sola, e cio' che distingue le sue parti e' il
          glifo con cui ciascuna comincia, non una linea. */}
      {variant === 'column' && (
        /* THE BOTTOM INSET COMES BACK WITH THE BAND, because it used to belong
           to the row underneath it. The status row carried the column's bottom
           breathing room (and, on a phone, the home-indicator band); it moved
           into the «Topics» menu and took the padding with it, leaving the
           identity band flush against the edge — measured 2026-08-31: band
           bottom at 800 on a 800px viewport, 4px of its own padding and nothing
           else. `ROW_INSET` is the same inset the header, the cards and the tab
           strip use: one number on every sidebar axis. `--sab` stays the floor
           so a home indicator is still cleared. */
        <div style={{ paddingBottom: `max(var(--sab), ${ROW_INSET}px)` }}>
          <IdentityBlock onOpenDevices={onOpenDevices} />
        </div>
      )}
      {variant === 'menu' && (
        <>
      {/* Horizontal inset = ROW_INSET (was px-3): the bottom bar lines up with
          the sidebar cards, the header, and the tab strip — one inset on every
          sidebar axis. */}
      {/* ONE line, always. In dev this bar used to demand ~310px of a ~244px
          sidebar (the right cluster gained a "dev" badge AND a build-age chip,
          the left readout gained CPU + fps), and since the container is nowrap
          the only flexible item — the left readout — absorbed all of it and
          hard-clipped mid-glyph. Wrapping to a second line fixed the clipping
          but looked worse, so the crowding is removed at the SOURCE instead:
          the two dev chips are merged into one, and the left readout truncates
          with an ellipsis rather than being severed. */}
      {/* NESSUNO SFONDO PROPRIO: eredita quello della colonna. Era `bg-app-bg`,
          cioè un token DIVERSO da quello della sidebar (`bg-surface` allora,
          `bg-app-chrome` adesso) — i due estremi della stessa colonna con due
          tinte, e su iPhone la fascia dell'home indicator (questo
          `paddingBottom`) di un colore e quella in cima di un altro.
          Ridipingerla con `bg-app-chrome` NON era la soluzione: sotto Tauri/mac
          quel token porta l'alpha 0.55 della vibrancy, e una seconda mano dentro
          la sidebar la comporrebbe con la prima (alpha efficace 0.80 contro
          0.55) — la stessa cucitura che la regola anti-compounding di
          `.chrome-glass` esiste per evitare, rientrata da un'altra porta.
          Non dipingere è l'unico modo di essere davvero la stessa superficie. */}
      {/* `max-md:min-h-11` — 44px sotto i 768px. Le due fasce in fondo alla
          colonna stavano a 28 e 24px: misurati col dito, i loro bottoni davano
          bersagli fra 24 e 28px di altezza, ed è il punto della sidebar dove il
          pollice arriva peggio. Sul desktop restano 28, dove il mouse è preciso
          e lo spazio verticale vale. */}
      {/* LA SAFE-AREA SI ABITA, NON SI LASCIA VUOTA.
          Era `paddingBottom: env(safe-area-inset-bottom)`, cioè la riga stava
          sopra la fascia e sotto restava una striscia morta alta 34px — su un
          iPhone un terzo dell'altezza di questa riga, spesa per non dire
          niente. «Metti lì sotto nella safe area la riga della status bar con
          tutto» (Attilio, 08/08): adesso la fascia è ALTEZZA della riga, non
          spazio sprecato sotto di lei, e `items-center` centra il contenuto
          nella banda intera. Col dito il contenuto finisce a ~39px dal bordo,
          quindi ben sopra l'home indicator, che ne occupa gli ultimi otto.
          `env()` si azzera da sé dove non c'è inset, quindi sul desktop questa
          riga resta esattamente la stessa di prima — nessun ramo, nessuna
          media query. L'altezza base viene da `isMobile` e non da `min-h-*`
          perché un `minHeight` in linea scavalcherebbe comunque la classe: due
          fonti per la stessa misura sono due fonti che divergono. */}
      {/* THE MUTE WAIT, SPOKEN. This is the one state where "reconnecting" is a
          lie by omission: nothing is coming back on its own, because the shell is
          waiting for a server this machine used to have and no longer has. The
          sentence names the cause and prints the marker's full path, which is the
          only way out and lives in a directory nobody visits. It appears ONLY on
          the shell's explicit verdict (`bootDegraded.ts`), so an ordinary restart
          still shows just the amber dot. It WRAPS and the path is selectable: a
          path you cannot read or copy is not a way out. */}
      {degradedLines && (
        <div
          data-testid="boot-degraded-notice"
          className={`flex flex-col gap-0.5 pt-1 pb-1.5 text-[11px] leading-snug ${SEGNALE_ATTESA}`}
          style={{
            paddingLeft: isMobile ? 'max(32px, var(--sal))' : ROW_INSET,
            paddingRight: isMobile ? 'max(32px, var(--sar))' : ROW_INSET,
          }}
        >
          <span>{tr(degradedLines.whyKey, { port: degradedLines.port })}</span>
          <span>{tr(degradedLines.wayOutKey)}</span>
          <span className="font-mono text-app-text-secondary select-text break-all">
            {degradedLines.markerPath}
          </span>
          {/* THE WAY OUT, DONE. Printing an AppData path and asking the person to
              quit the app, find it in a file manager and delete it by hand is a
              way out only on paper — and it is asked on the machine where the app
              is the thing that stopped working. The button does exactly what the
              sentence describes; the path stays above it, because a shell too old
              for the command still has only that. */}
          <button
            type="button"
            data-testid="boot-degraded-fix"
            className="mt-1 self-start underline underline-offset-2 hover:no-underline"
            onClick={async () => {
              setDegradedFixFailed(false);
              await clearBootDegraded();
              // Reached only when nothing happened: a success never returns here.
              setDegradedFixFailed(true);
            }}
          >
            {tr('statusBar.degraded.fix')}
          </button>
          {degradedFixFailed && <span>{tr('statusBar.degraded.fixFailed')}</span>}
        </div>
      )}
      <div
        data-testid="sidebar-status-bar"
        className="flex items-center gap-2 flex-shrink-0"
        style={{
          /**
           * PIÙ RIENTRO DOVE C'È L'ANGOLO TONDO.
           *
           * Sei pixel bastano su un bordo dritto; su un iPhone questa riga sta
           * SUL fondo, dove lo schermo curva con un raggio di ~55px, e i suoi
           * estremi finiscono dentro l'arco. Il conto, con R=55 e x = R −
           * √(R² − (R−y)²): alla quota del CENTRO del contenuto (y≈22px dal
           * fondo) l'arco mangia 11px per lato; al suo bordo INFERIORE (y≈10)
           * ne mangia 23.
           *
           * Trentadue, in tre giri: 16 copriva solo la quota centrale, 24 il
           * punto peggiore (il bordo basso del contenuto), e dal vivo erano
           * ancora «troppo vicine ai bordi laterali». La geometria dà il
           * MINIMO per non essere tagliati; quanto stare LARGHI oltre quel
           * minimo è una scelta di respiro, e 32 è il primo valore che legge
           * come «centrale» invece che «spinto ai lati». Sopra il minimo di 23,
           * quindi il taglio non torna comunque.
           *
           * `--sal`/`--sar` restano il pavimento: in orizzontale il notch mangia
           * da un lato solo, e lì il numero giusto lo dice il sistema.
           */
          paddingLeft: isMobile ? 'max(32px, var(--sal))' : ROW_INSET,
          paddingRight: isMobile ? 'max(32px, var(--sar))' : ROW_INSET,
          // `var(--sab)` e non `env(...)` diretto: `env()` non si può
          // sovrascrivere, quindi con la chiamata cruda questa riga era
          // IMPOSSIBILE da provare fuori da un iPhone vero — e infatti l'ho
          // sbagliata due volte a occhi chiusi. `--sab` è già definita in
          // `:root` come `env(safe-area-inset-bottom, 0px)`, quindi in
          // produzione il valore è identico, ma una sonda può forzarla e
          // misurare il risultato.
          //
          /**
           * LA FASCIA SI ASSORBE, NON SI SOMMA — terza e ultima versione, e le
           * prime due erano sbagliate in due modi opposti (misurate con
           * `--sab: 34px`):
           *
           *  · `paddingBottom`  → riga 78, contenuto a 56px dal bordo: la fascia
           *    era spazio MORTO sotto la riga.
           *  · `+ var(--sab)`   → riga 78, contenuto centrato (25,5 sopra / 24,5
           *    sotto): centrato sì, ma la riga si era solo INGRASSATA — «hai
           *    semplicemente alzato spazio sopra la status riga».
           *  · `+ var(--sab)/2` → riga 61: meglio, ancora alta per niente.
           *
           * `max()` invece di una somma: l'altezza è quella di sempre, e la
           * fascia la ALLARGA solo se da sola sarebbe più alta. Con 34px di
           * inset la riga resta 44 — la stessa di un telefono senza notch —
           * e il contenuto, centrato, cade a 22px dal fondo: dentro la fascia,
           * sopra l'home indicator (ultimi ~10px). Niente altezza inventata.
           */
          minHeight: `max(${isMobile ? 44 : 28}px, calc(var(--sab) + 10px))`,
        }}
      >
        {/* Gateway status */}
        <button
          ref={statusBtnRef}
          // `status-bar-connection`, no longer `connection-status`: that name
          // moved to the LAMP in the title row, which is the only thing left
          // outside the menu and therefore the only handle that says "the app
          // is up" without opening anything — which is how half the suite used
          // it (layout.fixture, multi-client, tab-sync). What stays here is the
          // GESTURE: opening the performance panel.
          data-testid="status-bar-connection"
          onClick={() => setShowStatusDropdown(!showStatusDropdown)}
          onMouseEnter={prefetchStatusPanel}
          onFocus={prefetchStatusPanel}
          className={`tap-expand-y flex items-center gap-1.5 text-[11px] ${SIDEBAR_HOVER} rounded px-1 py-1 transition-colors min-w-0 overflow-hidden ${showStatusDropdown ? SIDEBAR_ACTIVE : ''}`}
          title={tr('statusBar.perfTitle')}
        >
          {openclawAvailable ? (
            <>
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                gatewayOnline ? PALLINO_OK : PALLINO_GUASTO
              }`} />
              <Wifi size={10} className={gatewayOnline ? SEGNALE_OK : SEGNALE_GUASTO} />
              {/* The only elastic child: on a narrow sidebar THIS is what gives
                  way, with an ellipsis, so the numeric readouts to its right
                  (MB / CPU / fps) stay whole instead of being cut mid-digit. */}
              <span className={`min-w-0 truncate ${gatewayOnline ? 'text-app-text-secondary' : SEGNALE_GUASTO}`}>
                {gatewayOnline ? 'Online' : 'Offline'}
              </span>
              {/* Latency lives only in the dropdown Gateway row, next to its
                  "Refresh / Xs ago" control that discloses the 30s cache age —
                  in the bare bar it looked live but was stale + duplicated. */}
            </>
          ) : (
            <span
              /* Lo stato «server irraggiungibile» si dice col COLORE, non con
                 l'opacità: `bg-app-text-muted/40` sul chrome chiaro composita a
                 un grigio che non si distingue dal fondo, e un indicatore di
                 guasto che sparisce non è un indicatore. Grigio pieno contro
                 verde: sono due tinte, e si vedono entrambe. */
              className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${status ? PALLINO_OK : 'bg-app-text-muted'}`}
              title={status ? 'Topics server reachable' : 'Topics server unreachable'}
            />
          )}
          {/* UN GRUPPO SOLO, IL TOTALE — vedi il blocco `usage` più in alto.
              L'anteprima risponde a «quanto costa Topics in tutto»: una cifra di
              memoria e una percentuale, non due di ciascuna. Il glifo dice DOVE
              sono misurate: il telefono non misura i suoi processi, e lì il
              totale è dichiarato parziale con «~» invece di far passare la metà
              lato server per il tutto. Ciascun numero si mostra quando c'è UNA
              MISURA, anche se vale zero: `null` è l'unico «non misurato», perché
              un gate su `> 0` nascondeva l'app FERMA, cioè proprio quando «0%» è
              l'informazione che serve. */}
          {(usage.totalMB !== null || usage.totalCpu !== null || fps > 0) && (
            <span
              data-testid="metrics-total"
              className="flex flex-shrink-0 items-center gap-1 tabular-nums"
              title={totalTitle}
              // L'inventario si raccoglie SOLO da qui in poi. `focus` accanto a
              // `mouseenter` perche' questo gruppo vive dentro un <button>: chi
              // ci arriva da tastiera deve leggere lo stesso tooltip, non uno
              // piu' povero.
              onMouseEnter={showInventory}
              onFocus={showInventory}
            >
              {/* NO MACHINE GLYPH HERE ANY MORE: which machine these numbers
                  are measured on is written, with its own icon, in the
                  identity chip right above, and the partial measure of a
                  phone is already declared by the leading "~". A second
                  monitor icon under the first one was decoration. */}
              {usage.totalMB !== null && (
                <span className={`text-app-text-secondary ${totalMemHigh ? SEGNALE_ATTESA : ''}`}>
                  {partialSign(usage.memPartial)}{fmtMB(usage.totalMB)}
                </span>
              )}
              {usage.totalCpu !== null && (
                <span className={`text-app-text-secondary ${totalCpuHigh ? SEGNALE_ATTESA : ''}`}>
                  {partialSign(usage.cpuPartial)}{formatCpuPercent(usage.totalCpu)}%
                </span>
              )}
              {fps > 0 && (
                <span className={`text-app-text-secondary ${fps < 30 ? SEGNALE_GUASTO : fps < 50 ? SEGNALE_ATTESA : ''}`}>{fps}fps</span>
              )}
            </span>
          )}
        </button>

        {/* THE AGENTS ARE NOT HERE ANY MORE. The robot and the hourglass
            moved up into the identity chip, two lines above: they counted the
            same fleet the presence summary counts, and they counted it far
            from the person the fleet belongs to, in the middle of the
            megabytes. No copy is left down here: two places counting the same
            thing are two places that end up saying two different numbers, and
            the wrong one is always the one under your eyes all day. See
            `IdentityBlock.tsx`. */}

        {/* WebSocket connection status — moved here from the sidebar header.
            Only visible when not connected; offline = red, connecting/
            reconnecting = amber. The dot pulses; the label stays steady. */}
        {wsStatus && wsStatus !== 'connected' && (
          <span
            data-testid="ws-connection-status"
            className={`flex items-center gap-1.5 text-[11px] min-w-0 overflow-hidden ${
              wsStatus === 'offline' ? SEGNALE_GUASTO : SEGNALE_ATTESA
            }`}
            title={tr('statusBar.wsTitle')}
          >
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 animate-pulse ${
              wsStatus === 'offline' ? PALLINO_GUASTO : PALLINO_ATTESA
            }`} />
            <span className="truncate">
              {wsStatus === 'connecting' ? 'Connecting…' : wsStatus === 'reconnecting' ? 'Reconnecting…' : 'Offline'}
            </span>
          </span>
        )}

        {/* Data-fetch notice (e.g. "Using cached data — server unreachable")
            moved here from the red sidebar banner. Shown only when the WS IS
            connected — otherwise the WS status above already says it all. */}
        {wsStatus === 'connected' && dataNotice && (
          <span
            data-testid="data-notice"
            className={`flex items-center gap-1.5 text-[11px] ${SEGNALE_ATTESA} min-w-0 overflow-hidden`}
            title={dataNotice}
          >
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${PALLINO_ATTESA}`} />
            <span className="truncate">{dataNotice}</span>
          </span>
        )}

        <span className="ml-auto flex-shrink-0 flex items-center gap-1.5 text-[11px] text-app-text-secondary tabular-nums whitespace-nowrap">
          {/* The chip and its badge live in VersionChip: the divergence between
              the client on screen and the shell the updater replaces is a thing
              a test has to be able to MOUNT, and this component does not mount
              (perf metrics, system status, shell bridge, a dozen stores). */}
          <VersionChip
            appVersion={appVersion}
            shellVersion={shellVersion}
            drift={drift}
            devInstall={devInstall}
            hmrAge={isDev && lastChangeTime ? formatBuildTime(lastChangeTime) : undefined}
            desktop={isDesktop}
            popoverOpen={showVersionPopover}
            onOpen={(anchor) => { setVersionAnchor(anchor); setShowVersionPopover(v => !v); }}
          />
          {/* Quiet "auto-update" badge: the server has dev bundle hot-delivery ON
              (topics-dev.json) so windows self-reload on each rebuild — no popup.
              Driven by server status, so it shows in the PROD-minified desktop
              bundle too (unlike the Vite-only `dev` badge above). Hidden when
              isDev (the amber `dev` already implies live reload). */}
          {/* IL BADGE «auto» E' STATO TOLTO. Diceva una cosa vera in un
              posto dove sette informazioni si contendono ~200px, e la sua
              conseguenza pratica - «non devi fare niente» - ora si vede da
              sola: in automatico l'avviso di nuova versione non compare
              proprio. Un simbolo che segnala l'assenza di un'azione e' un
              simbolo che si guarda una volta e poi mai piu'.
              Lo STATO resta leggibile nel dropdown della versione, che e' dove
              si va a chiedere «a che punto sono con gli aggiornamenti». */}
          {/* Relative "X fa" = last local update. Shown in dev (HMR-tracked) and
              for a recent local build (the desktop app runs the built bundle even
              while developing). Hidden on a stale shipped release. */}
          {/* E VIA ANCHE «X fa». Rispondeva a «quando e' stata costruita
              questa build», che e' una domanda da dropdown della versione, non
              da riga di stato: li' compete per larghezza con gli fps, la
              memoria e la versione, che si guardano di continuo. */}
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            // NIENTE `tap-expand` qui, e il motivo e' che questo bottone RIAVVIA L'APP.
            // 44x44 proiettati attorno a un glifo da 10px in un box `p-0.5`
            // (~14px) sbordano ~15px per lato, e il vicino a sinistra — il
            // numero di versione — dista `gap-1.5` = 6px. Questo bottone viene
            // DOPO nel DOM, quindi il suo `::after` vince l'hit-test: col dito gli
            // ultimi ~9px di «v2.2.38» riavviavano l'app invece di aprire il
            // popover. Un'area invisibile che ruba il tocco a un vicino e' gia'
            // sbagliata; che l'azione rubata sia distruttiva la rende inaccettabile.
            // Si allarga il BOX vero su touch (28px, quanto la riga), che non ruba
            // niente a nessuno.
            className={`p-0.5 md:p-0.5 w-7 h-7 md:w-auto md:h-auto flex items-center justify-center rounded ${SIDEBAR_HOVER} transition-colors ${updateAvailable ? 'text-primary' : 'text-app-text-muted'}`}
            title={isDesktop ? tr('statusBar.restartApp') : updateAvailable ? tr('statusBar.updateAvailable') : tr('statusBar.reload')}
          >
            {/* Distinct glyph from the dropdown's data-refresh (RefreshCw): the
                bar button RESTARTS the app (desktop shell) — a different, heavier
                action that shouldn't look identical sitting next to it. */}
            {isDesktop
              ? <RotateCcw size={10} className={refreshing ? 'animate-spin' : ''} />
              : <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />}
          </button>
        </span>
      </div>

      {/* eslint-disable-next-line react-hooks/refs -- portal is positioned against the status button's live geometry; the rect must be read at render time and re-renders alongside this component so the placement stays in sync */}
      {showStatusDropdown && statusBtnRef.current && createPortal(
        <div
          ref={statusDropdownRef}
          // THE SHARED POSITIONER decides the side, not a hand-rolled `bottom:`.
          //
          // This panel grew UPWARD by construction, and that was right while the
          // bar lived at the foot of the column: above it there is only screen.
          // Since the bar moved into the «Topics» menu (SIDEBAR-STATUS-01) its
          // anchor sits near the TOP, and an always-upward panel opens into the
          // ceiling — the same defect measured on the version popover, which
          // landed two pixels from the edge. `computeMenuPosition` opens below,
          // flips above only when there is no room, clamps both sides and caps
          // the height to the side it actually chose.
          className={`${POPOVER_PANEL} min-w-[320px] overflow-y-auto overscroll-contain`}
          // eslint-disable-next-line react-hooks/refs -- anchor geometry: one read of the live button node, which is what positions a fixed panel against it
          style={(() => {
            const r = statusBtnRef.current.getBoundingClientRect();
            const pos = computeMenuPosition(
              { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
              { width: 320, height: STATUS_PANEL_H_ESTIMATE },
              { align: 'left', gap: 4, margin: POPOVER_MARGIN },
            );
            return {
              position: 'fixed' as const,
              top: pos.top,
              left: pos.left,
              maxHeight: pos.maxHeight,
              zIndex: Z_POPOVER,
            };
          })()}
        >
          {/* Performance block — non-lazy so the dropdown opens instantly with
              the live FPS history; the heavier system panel streams in below. */}
          <PerfSection />
          <Suspense fallback={<div className="p-3 text-[11px] text-app-text-muted text-center">Loading...</div>}>
            <SystemStatusPanel enabled />
          </Suspense>
        </div>,
        document.body
      )}

      {showVersionPopover && (
        <VersionPopover
          anchorEl={versionAnchor}
          appVersion={appVersion}
          shellVersion={shellVersion}
          drift={drift}
          isDev={isDev}
          buildDate={BUILD_TIME ? formatBuildDate(BUILD_TIME) : ''}
          buildSha={BUILD_SHA}
          onClose={() => setShowVersionPopover(false)}
          onOpenChangelog={() => {
            setShowVersionPopover(false);
            if (onOpenChangelog) onOpenChangelog(appVersion);
            else setShowChangelog(true);
          }}
        />
      )}

      {showChangelog && (
        <ChangelogModal currentVersion={appVersion} onClose={() => setShowChangelog(false)} />
      )}
        </>
      )}
    </>
  );
}
