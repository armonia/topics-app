import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Wifi, RefreshCw, RotateCcw, Bot, Hourglass, Smartphone, Monitor } from 'lucide-react';
import { createPortal } from 'react-dom';
import { reloadAllWindows } from '@/lib/shell/app';
import { subscribeSession, type SessionState } from '@/lib/auth/session';
import { useSystemStatus } from '@/hooks/useSystemStatus';
import { useServiceWorkerUpdate } from '@/hooks/useServiceWorkerUpdate';
import { useOpenClawAvailable } from '@/hooks/useOpenClawAvailable';
import { useDismissable } from '@/hooks/useDismissable';
import { POPOVER_MARGIN, POPOVER_PANEL, Z_POPOVER } from '@/lib/popoverStyles';
import { useFps, useFpsActive } from '@/lib/fpsMonitor';
import { formatCpuPercent, usePerfMetrics } from '@/hooks/usePerfMetrics';
import { PerfSection } from './PerfSection';
import { VersionPopover } from './VersionPopover';
import { ChangelogModal } from '../ChangelogModal';
import type { ConnectionStatus } from '@/types';
import { ROW_INSET, SIDEBAR_ACTIVE, SIDEBAR_HOVER, TIER_DONE_TEXT } from '@/lib/selectionStyles';
import { isDesktop } from '@/lib/shell';
import { getVersion, relaunch } from '@/lib/shell/app';
import { useAgentActivityCounts } from '@/state/signals';
import { useTopics, useTerminalSessions } from '@/contexts/TopicsContext';

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

/* I TRE SEGNALI DELLA BARRA, MISURATI SUL CHROME E NON SU UNA PANE.
 *
 * Questa riga vive sul chrome della sidebar (`--chrome-bg`: #eaecf0 in chiaro,
 * #080a0e in scuro), che in chiaro è più SCURO di una superficie di contenuto.
 * Le tinte qui erano scritte nude sulla scala 500 — `text-amber-500`,
 * `text-emerald-500`, `text-red-500` — cioè tarate per il fondo scuro e basta.
 * Misurato sulla palette vera (oklch → sRGB) sul chrome dei due temi:
 *
 *              chiaro   scuro
 *   amber-500    1,82    9,22   ← «2,1GB» in rosso-allarme che non si legge
 *   emerald-500  2,09    8,03
 *   red-500      3,24    5,18
 *
 * Le coppie qui sotto sono la soluzione, non una scelta di gusto: sul chrome
 * chiaro la scala 700 non basta per ambra e verde (4,28 e 4,19), quindi il
 * TESTO scende alla 800 e in scuro risale alla 400.
 *
 *   emerald-800 / emerald-400   6,42 / 10,24
 *   amber-800   / amber-400     6,04 / 11,52
 *   red-700     / red-400       5,44 /  6,84
 *
 * I PALLINI sono grafica, non testo: la soglia è 3:1 e non 4,5:1, e a sei pixel
 * una tinta troppo scura smette di leggersi come «verde» o «ambra» e diventa un
 * puntino sporco. Restano quindi due gradini più su, dove passano lo stesso.
 *
 *   emerald-600 / emerald-400   3,10 / 10,24
 *   amber-700   / amber-400     4,28 / 11,52
 *   red-500     / red-400       3,24 /  6,84
 *
 * (Il pannello dei file, che sta su `--bg-elevated` — più chiaro — ha la SUA
 * taratura in `lib/gitStatusColors.ts`, dove la scala 700 basta. Due superfici,
 * due misure: è la stessa ragione per cui il chrome si ritara terziario e bordi
 * in index.css.) */
const SEGNALE_OK = 'text-emerald-800 dark:text-emerald-400';
const SEGNALE_ATTESA = 'text-amber-800 dark:text-amber-400';
const SEGNALE_GUASTO = 'text-red-700 dark:text-red-400';
const PALLINO_OK = 'bg-emerald-600 dark:bg-emerald-400';
const PALLINO_ATTESA = 'bg-amber-700 dark:bg-amber-400';
const PALLINO_GUASTO = 'bg-red-500 dark:bg-red-400';

function formatBuildDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' });
  } catch { return iso; }
}

// Prefetch the lazy status panel chunk so the dropdown opens instantly instead
// of flashing a "Loading…" while the chunk downloads on first click. Triggered
// on hover/focus of the trigger button. Vite dedupes with the lazy() import().
let _statusPanelPrefetched = false;
function prefetchStatusPanel() {
  if (_statusPanelPrefetched) return;
  _statusPanelPrefetched = true;
  import('./SystemStatusPanel').catch(() => { _statusPanelPrefetched = false; });
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

const SystemStatusPanel = lazy(() => import('./SystemStatusPanel').then(m => ({ default: m.SystemStatusPanel })));

export function SidebarStatusBar({ wsStatus, dataNotice, onOpenDevices }: {
  wsStatus?: ConnectionStatus;
  dataNotice?: string | null;
  /** Apre Impostazioni → Account. La riga dell'identità è il punto da cui si
   *  arriva ai dispositivi: chi si chiede «chi sono qui?» si chiede subito dopo
   *  «e chi altro?», e farglielo cercare in un pannello è farlo cercare. */
  onOpenDevices?: () => void;
} = {}) {
  // Subscribed HERE, in the leaf that shows the number, not up in App.
  // `useAgentActivityCounts` reads seven signal Sets through useShallow, so
  // while App held it a single `terminal:activity` frame — several a second
  // with a dozen live PTYs — re-rendered App, and with it PanelGrid and the
  // whole sidebar, for a chip in the corner. Nothing else ever read it.
  const agentCounts = useAgentActivityCounts(useTerminalSessions(), useTopics());
  // Slow polling for the status bar (60s)
  const { status } = useSystemStatus(true, 60000);
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
  // Evaluated once at mount via a lazy initializer — the wall-clock read stays
  // out of the (pure) render body, and a coarse 24h "recent build" boolean has
  // no reason to re-tick mid-session.
  const [buildIsRecent] = useState(() => {
    try {
      return !!BUILD_TIME && (Date.now() - new Date(BUILD_TIME).getTime()) < 24 * 60 * 60 * 1000;
    } catch { return false; }
  });

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
  // Titolo = shell + lato server. Dal 2026-08-04 le due metà usano la STESSA
  // metrica (`phys_footprint`, quella di Monitoraggio Attività): prima il lato
  // server sommava `ps rss` e la somma univa due unità diverse — misurato,
  // 2,07 GB di rss contro 1,17 di footprint sullo stesso albero. `memMetric`
  // dice quale metrica è arrivata davvero, perché su una piattaforma senza
  // `proc_pid_rusage` si ripiega ancora su rss e va detto invece che nascosto.
  const totalMemMB = appMemMB !== null
    ? appMemMB + (serverSideMemMB ?? 0)
    : serverSideMemMB;
  // Whole-app figures can legitimately be large, so the alarm sits where it was
  // always meant to (>3 GB); a partial reading is shell-only and keeps its own
  // much lower bar.
  const memHigh = appMemMB !== null
    ? (totalMemMB ?? 0) > (isPartialMem ? 1024 : 3072)
    : (serverSideMemMB ?? 0) > 512;
  const serverSideLine = fleet
    ? `\n· lato server, ${fleet.processCount} processi: ${fleet.memoryMB} MB`
      + (fleet.memMetric === 'footprint' ? '' : fleet.memMetric === 'mixed' ? ' (footprint parziale)' : ' (RSS, stima alta)')
      + fleet.roots
          .filter(r => r.kind !== 'server' && r.memoryMB > 0)
          .map(r => `\n   · ${r.kind}: ${r.memoryMB} MB, ${r.processCount} proc.`)
          .join('')
    : `\n· server Bun (processo separato): ${serverMemMB ?? '—'} MB`;
  const memTitle = appMemMB !== null
    ? (isPartialMem
        ? `Topics (processo shell): ${appMemMB} MB — ${memMetric === 'footprint' ? 'footprint' : 'memoria residente (RSS)'}\n· NON include i processi WKWebView (contenuto browser dei pannelli)`
        : `Topics, ${procCount ?? '?'} processi: ${appMemMB} MB di footprint — lo stesso valore di Activity Monitor\n· di cui in RAM adesso: ${residentMemMB ?? '—'} MB (il resto è compresso o in swap)`
      ) + serverSideLine
    : status
      ? (fleet
          ? `Lato server, ${fleet.processCount} processi: ${fleet.memoryMB} MB (RSS)\n· processo server: ${serverMemMB} MB (heap ${status.server.heapUsedMB} MB)`
            + fleet.roots
                .filter(r => r.kind !== 'server' && r.memoryMB > 0)
                .map(r => `\n· ${r.kind}: ${r.memoryMB} MB, ${r.processCount} proc.`)
                .join('')
            + `\n· la memoria della shell è disponibile solo nell'app desktop`
          : `Processo server: ${serverMemMB} MB (heap ${status.server.heapUsedMB} MB) — la memoria dell'app è disponibile solo nell'app desktop`)
      : '';

  // Stessa storia per la CPU: la cifra della shell da sola nasconde i sidecar, ed
  // è lì che sta il carico (il solo bridge WebRTC ha misurato ~29% mentre
  // streammava). Ma le due metà si sommano SENZA far ricadere un "non misurato"
  // su zero: `null` significa che quella metà non ha una misura, e una somma di
  // cui manca un pezzo non è il totale. Se mancano entrambe, non c'è niente da
  // mostrare; se ne manca una, il tooltip dice quale.
  const shellCpu = perf?.cpu.total ?? null;
  const fleetCpu = fleet?.cpuPercent ?? null;
  const totalCpu = shellCpu === null && fleetCpu === null
    ? null
    : (shellCpu ?? 0) + (fleetCpu ?? 0);
  const cpuTitle = [
    shellCpu !== null
      ? (isPartialMem
          ? `CPU processo shell di Topics: ${formatCpuPercent(shellCpu)}% — non include i processi WKWebView dei pannelli`
          : `CPU dei ${procCount ?? '?'} processi della shell: ${formatCpuPercent(shellCpu)}%`)
      : 'CPU della shell: non ancora misurata (serve un secondo campione)',
    fleetCpu !== null
      ? `lato server, ${fleet?.processCount ?? '?'} processi: ${formatCpuPercent(fleetCpu)}%`
      : 'lato server: non misurato',
    'può superare 100% (per core)',
    // Copertura parziale DENTRO la metà shell: alcuni pid sono appena comparsi.
    perf && perf.cpu.pids > 0 && perf.cpu.sampled < perf.cpu.pids
      ? `shell misurata su ${perf.cpu.sampled}/${perf.cpu.pids} processi — gli altri non hanno ancora un delta`
      : null,
  ].filter(Boolean).join('\n· ');

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
  const [shellVersion, setShellVersion] = useState('');
  useEffect(() => {
    if (!isDesktop) return;
    getVersion().then(v => { if (v) setShellVersion(v); }).catch(() => {});
  }, []);

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
  });

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
      {/* CHI SEI, sopra la barra di stato.
          Una riga sola, e solo quando c'e' qualcosa da dire. Un'autenticazione
          che non si vede e' indistinguibile dalla sua assenza: e' il difetto per
          cui il pairing precedente, che pure funzionava, non e' mai servito a
          nessuno — dal telefono l'unico segnale era «Reconnecting…» per sempre.
          Sul computer non compare: li' l'identita' e' il fatto di essere seduti
          davanti alla macchina, e ripeterlo sarebbe rumore a ogni riga. */}
      <DeviceIdentityRow onOpenDevices={onOpenDevices} />
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
      <div
        data-testid="sidebar-status-bar"
        className="flex items-center gap-2 min-h-7 max-md:min-h-11 flex-shrink-0 border-t border-app-border"
        style={{
          paddingInline: ROW_INSET,
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        }}
      >
        {/* Gateway status */}
        <button
          ref={statusBtnRef}
          data-testid="connection-status"
          onClick={() => setShowStatusDropdown(!showStatusDropdown)}
          onMouseEnter={prefetchStatusPanel}
          onFocus={prefetchStatusPanel}
          className={`tap-expand-y flex items-center gap-1.5 text-[11px] ${SIDEBAR_HOVER} rounded px-1 py-1 transition-colors min-w-0 overflow-hidden ${showStatusDropdown ? SIDEBAR_ACTIVE : ''}`}
          title="Performance & stato sistema — apri per FPS live"
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
          {totalMemMB !== null && (
            <span
              className={`flex-shrink-0 text-app-text-muted tabular-nums ${memHigh ? SEGNALE_ATTESA : ''}`}
              title={memTitle}
            >
              {/* Whole-app footprint runs to several GB with many panes open;
                  "6937MB" in a status bar is a wall of digits, so switch unit. */}
              {totalMemMB >= 1024 ? `${(totalMemMB / 1024).toFixed(1)}GB` : `${totalMemMB}MB`}
            </span>
          )}
          {/* Si mostra quando c'è UNA MISURA — anche se vale zero. Il gate era
              `> 0`, e nascondeva due casi diversi con lo stesso pretesto: "non
              ho ancora una baseline" e "ho misurato, è quasi zero". Il secondo è
              un'app FERMA, cioè proprio quando "0%" è l'informazione che serve, e
              lì il contatore spariva. Ora `null` è l'unico "non misurato". */}
          {totalCpu !== null && (
            <span
              className={`flex-shrink-0 text-app-text-muted tabular-nums ${totalCpu > 50 ? SEGNALE_ATTESA : ''}`}
              title={cpuTitle}
            >
              {formatCpuPercent(totalCpu)}%
            </span>
          )}
          {fps > 0 && (
            <span className={`flex-shrink-0 text-app-text-muted tabular-nums ${fps < 30 ? SEGNALE_GUASTO : fps < 50 ? SEGNALE_ATTESA : ''}`}>{fps}fps</span>
          )}
        </button>

        {/* Live Claude Code agents: 🤖 = working now (running/tool-running),
            ⏳ = parked awaiting you. Hidden when neither, matching the bar's
            "only show live signals" convention (fps, ws-status).

            The hourglass follows the SAME two tiers as every other surface
            (`attentionTierForPhase`): amber only for `awaiting-approval` — a
            permission gate that wants an answer now — and calm blue for the
            rest, which merely means the turn ended. Painting the whole set
            amber made a pile of finished turns look like a pile of prompts. */}
        {agentCounts && (agentCounts.working > 0 || agentCounts.awaiting > 0) && (
          <span
            data-testid="agent-count"
            className="flex items-center gap-1.5 text-[11px] flex-shrink-0 tabular-nums"
            // Il tooltip dice cosa CONTA, non cosa suona bene: il gruppo blu è
            // «ha finito e non l'hai ancora guardata» — turni conclusi più
            // sessioni parcheggiate — ed è lo stesso insieme che porta il badge
            // sulle tab. Il conteggio ne stava fuori per metà, e la frase
            // «con il turno finito» era già lì a descrivere un altro insieme.
            title={[
              'Agenti Claude Code',
              `· ${agentCounts.working} al lavoro`,
              agentCounts.awaitingInput > 0 ? `· ${agentCounts.awaitingInput} in attesa di una tua risposta` : '',
              agentCounts.awaiting - agentCounts.awaitingInput > 0
                ? `· ${agentCounts.awaiting - agentCounts.awaitingInput} da guardare (turno finito o in pausa)`
                : '',
              '',
              'Non contano le chat archiviate e le sessioni chiuse: non hanno una riga dove andarle a spegnere.',
            ].filter(Boolean).join('\n')}
          >
            {agentCounts.working > 0 && (
              <span className={`flex items-center gap-0.5 ${SEGNALE_OK}`}>
                <Bot size={12} className="animate-pulse" />
                {agentCounts.working}
              </span>
            )}
            {agentCounts.awaitingInput > 0 && (
              <span data-testid="agent-count-input" className={`flex items-center gap-0.5 ${SEGNALE_ATTESA}`}>
                <Hourglass size={10} />
                {agentCounts.awaitingInput}
              </span>
            )}
            {/* Same blue as the 'done' tier everywhere else (SpaceSwitcher's dot,
                the awaiting fill) — one colour per tier, no new palette. */}
            {agentCounts.awaiting - agentCounts.awaitingInput > 0 && (
              <span data-testid="agent-count-done" className={`flex items-center gap-0.5 ${TIER_DONE_TEXT}`}>
                <Hourglass size={10} />
                {agentCounts.awaiting - agentCounts.awaitingInput}
              </span>
            )}
          </span>
        )}

        {/* WebSocket connection status — moved here from the sidebar header.
            Only visible when not connected; offline = red, connecting/
            reconnecting = amber. The dot pulses; the label stays steady. */}
        {wsStatus && wsStatus !== 'connected' && (
          <span
            data-testid="ws-connection-status"
            className={`flex items-center gap-1.5 text-[11px] min-w-0 overflow-hidden ${
              wsStatus === 'offline' ? SEGNALE_GUASTO : SEGNALE_ATTESA
            }`}
            title="Stato connessione realtime al server Topics"
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

        <span className="ml-auto flex-shrink-0 flex items-center gap-1.5 text-[11px] text-app-text-muted tabular-nums whitespace-nowrap">
          {appVersion && (
            <button
              data-version-anchor
              onClick={(e) => { setVersionAnchor(e.currentTarget); setShowVersionPopover(v => !v); }}
              className={`tap-expand-y text-app-text-muted hover:text-app-text-secondary ${SIDEBAR_HOVER} rounded px-1 py-1 -mx-0.5 transition-colors ${showVersionPopover ? `${SIDEBAR_ACTIVE} text-app-text-secondary` : ''}`}
              title="Info versione e aggiornamenti"
            >
              v{appVersion}
            </button>
          )}
          {/* In dev the build age rides INSIDE this badge ("dev · 12m") instead
              of costing a second chip plus its gap — the two always appeared
              together, and separating them is what tipped the bar past the
              sidebar width. */}
          {isDev && (
            <span
              className={`px-1 rounded bg-amber-500/15 ${SEGNALE_ATTESA} font-medium text-[10px] leading-tight`}
              title={`Build di sviluppo (Vite dev server / hot reload). In produzione questo badge sparisce.${lastChangeTime ? ` Ultimo aggiornamento codice: ${formatBuildTime(lastChangeTime)} fa.` : ''}`}
            >
              dev{lastChangeTime ? ` · ${formatBuildTime(lastChangeTime)}` : ''}
            </span>
          )}
          {/* Quiet "auto-update" badge: the server has dev bundle hot-delivery ON
              (topics-dev.json) so windows self-reload on each rebuild — no popup.
              Driven by server status, so it shows in the PROD-minified desktop
              bundle too (unlike the Vite-only `dev` badge above). Hidden when
              isDev (the amber `dev` already implies live reload). */}
          {!isDev && status?.server?.devReload && (
            <span
              className={`flex items-center gap-0.5 px-1 rounded bg-emerald-500/15 ${SEGNALE_OK} font-medium text-[10px] leading-tight`}
              title="Auto-aggiornamento attivo: le finestre si ricaricano da sole ai nuovi build, senza popup. (Spegni rimuovendo topics-dev.json dallo STATE_DIR e riavviando il server.)"
            >
              <RefreshCw size={9} />
              auto
            </span>
          )}
          {/* Relative "X fa" = last local update. Shown in dev (HMR-tracked) and
              for a recent local build (the desktop app runs the built bundle even
              while developing). Hidden on a stale shipped release. */}
          {!isDev && buildIsRecent && lastChangeTime && (
            <span title={`Ultimo aggiornamento codice: ${formatBuildTime(lastChangeTime)} fa`}>
              {formatBuildTime(lastChangeTime)}
            </span>
          )}
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
            title={isDesktop ? 'Riavvia l\'app' : updateAvailable ? 'Aggiornamento disponibile' : 'Ricarica'}
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
          // POPOVER_PANEL instead of a verbatim copy of its class string, and a
          // height cap: this panel is anchored to the BOTTOM bar and grows
          // upward (PerfSection + the lazy SystemStatusPanel), with no max-h it
          // ran straight off the TOP of the viewport on a short window and the
          // overflowing rows were simply unreachable. Cap to the space actually
          // available above the button and scroll inside.
          className={`${POPOVER_PANEL} min-w-[320px] overflow-y-auto overscroll-contain`}
          style={{
            position: 'fixed',
            // eslint-disable-next-line react-hooks/refs -- same anchor-geometry read: getBoundingClientRect against the live button node positions the fixed dropdown above it
            bottom: window.innerHeight - statusBtnRef.current.getBoundingClientRect().top + 4,
            // eslint-disable-next-line react-hooks/refs -- same anchor-geometry read for horizontal placement
            left: Math.max(POPOVER_MARGIN, statusBtnRef.current.getBoundingClientRect().left),
            // eslint-disable-next-line react-hooks/refs -- same anchor-geometry read: the cap is "everything above the button, minus a margin"
            maxHeight: statusBtnRef.current.getBoundingClientRect().top - 4 - POPOVER_MARGIN,
            zIndex: Z_POPOVER,
          }}
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
          isDev={isDev}
          buildDate={BUILD_TIME ? formatBuildDate(BUILD_TIME) : ''}
          buildSha={BUILD_SHA}
          onClose={() => setShowVersionPopover(false)}
          onOpenChangelog={() => { setShowVersionPopover(false); setShowChangelog(true); }}
        />
      )}

      {showChangelog && (
        <ChangelogModal currentVersion={appVersion} onClose={() => setShowChangelog(false)} />
      )}
    </>
  );
}

/**
 * L'identita' della sessione, sopra la barra di stato.
 *
 * Mostrata SEMPRE, anche sul computer. Il primo taglio la rendeva muta in
 * loopback col ragionamento «li' l'identita' e' il presupposto, non
 * un'informazione» — sbagliato in pratica: chi ha appena appaiato un telefono
 * apre l'app sul Mac per controllare che sia andata, e non trova niente. Una
 * riga che compare solo altrove non e' minimalismo, e' un buco dove ci si
 * aspetta una conferma. Sul computer dice «Questo computer», che e' anche il
 * modo di dire che qui dentro si e' per trasporto e non per sessione.
 */
function DeviceIdentityRow({ onOpenDevices }: { onOpenDevices?: () => void }) {
  const [session, setSession] = useState<SessionState>({ status: 'loading' });
  const [altri, setAltri] = useState<{ connessi: number; totali: number } | null>(null);
  useEffect(() => subscribeSession(setSession), []);

  // Quanti dispositivi ci sono, e quanti sono vivi adesso. È l'informazione che
  // rende la riga una RISPOSTA e non un'etichetta: «Questo computer» da solo non
  // dice niente che non si sappia già stando seduti davanti.
  const caricaAltri = useCallback(async () => {
    try {
      // La guardia sta QUI e non nell'effetto: un effetto che decide se chiamare
      // è un effetto che scrive stato in modo condizionale, ed è la forma che
      // `set-state-in-effect` marca. Chiamare sempre, e non fare niente quando
      // non serve, è la stessa cosa con una responsabilità in meno.
      const r = await fetch('/api/auth/devices', { credentials: 'same-origin' });
      if (!r.ok) return;
      const b = await r.json() as { devices: Array<{ connected: boolean; revokedAt: number | null }> };
      const vivi = (b.devices ?? []).filter((d) => d.revokedAt === null);
      setAltri({ connessi: vivi.filter((d) => d.connected).length, totali: vivi.length });
    } catch { /* transitorio: la riga resta senza conteggio invece di mentire */ }
  }, []);

  // Il conteggio si prende DOPO il primo paint, non durante. Questa riga sta in
  // fondo alla sidebar e il suo numero non serve a nessuno nel primo frame:
  // farlo partire dentro l'effetto significherebbe una scrittura di stato
  // sincrona in montaggio — che è ciò che `set-state-in-effect` marca, e ha
  // ragione. Un rinvio a zero millisecondi lo toglie dal percorso critico
  // davvero, non lo nasconde.
  useEffect(() => {
    const chiedi = () => { void caricaAltri(); };
    const primo = setTimeout(chiedi, 0);
    window.addEventListener('topics:auth-pair-resolved', chiedi);
    window.addEventListener('topics:auth-device-revoked', chiedi);
    return () => {
      clearTimeout(primo);
      window.removeEventListener('topics:auth-pair-resolved', chiedi);
      window.removeEventListener('topics:auth-device-revoked', chiedi);
    };
  }, [caricaAltri]);

  if (session.status !== 'paired') return null;
  const locale = session.as === 'loopback';

  return (
    <button
      data-testid="device-identity"
      onClick={onOpenDevices}
      disabled={!onOpenDevices}
      // Il filo sta dalla parte da cui la riga si stacca dal resto: sotto la
      // barra quando la barra è in cima (o si sommerebbe a quello dell'header),
      // sopra quando la barra è in fondo.
      // NIENTE `bg-app-bg`, e l'hover è quello del chrome. Questa riga sta
      // DENTRO la sidebar, che è chrome: dipingerci sopra il colore della
      // PAGINA la faceva leggere come una superficie estranea incollata in
      // fondo alla colonna, e sotto Tauri/mac quel colore è opaco mentre il
      // chrome è vetro — una striscia solida in mezzo alla vibrancy.
      // L'hover andava nello stesso verso sbagliato: `--bg-hover` è tarato per
      // una pane di contenuto e in tema chiaro è più CHIARO del chrome, cioè la
      // riga SCHIARIVA passandoci sopra mentre ogni altra riga della colonna
      // scurisce (è il caso descritto per esteso su SIDEBAR_HOVER).
      className={`flex w-full items-center gap-1.5 border-t border-app-border text-left text-[11px] text-app-text-secondary min-h-6 max-md:min-h-9 ${SIDEBAR_HOVER} disabled:hover:bg-transparent`}
      style={{ paddingInline: ROW_INSET }}
      title="Apri l\u2019elenco dei dispositivi autorizzati"
    >
      {locale
        ? <Monitor size={10} className="flex-shrink-0 text-app-text-muted" />
        : <Smartphone size={10} className="flex-shrink-0 text-app-text-muted" />}
      <span className="truncate">{session.name}</span>
      {altri && altri.totali > 0 && (
        <span className="ml-auto flex flex-shrink-0 items-center gap-1 text-app-text-muted">
          {altri.connessi > 0 && <span className={`h-1.5 w-1.5 rounded-full ${PALLINO_OK}`} />}
          {altri.connessi > 0 ? `${altri.connessi}/${altri.totali}` : `${altri.totali}`}
        </span>
      )}
    </button>
  );
}

