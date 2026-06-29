import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Wifi, RefreshCw, RotateCcw, Bot, Hourglass } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useSystemStatus } from '@/hooks/useSystemStatus';
import { useServiceWorkerUpdate } from '@/hooks/useServiceWorkerUpdate';
import { useOpenClawAvailable } from '@/hooks/useOpenClawAvailable';
import { useFps, useFpsActive } from '@/lib/fpsMonitor';
import { usePerfMetrics } from '@/hooks/usePerfMetrics';
import { PerfSection } from './PerfSection';
import { VersionPopover } from './VersionPopover';
import type { ConnectionStatus } from '@/types';
import { ROW_INSET } from '@/lib/selectionStyles';

declare const __BUILD_TIME__: string;
declare const __APP_VERSION__: string;

// App version baked at build time (from electron-app/package.json). In the
// desktop app the live `electronAPI.app.getVersion()` is preferred at runtime
// since an auto-update can change it after this bundle was built.
const BUILD_APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '';

// When this bundle was compiled (`vite build`). In dev the "X fa" chip tracks
// live HMR and means "last code change"; in prod that branch is dead code, so
// the value is just the build timestamp — showing it as "ultimo aggiornamento
// codice" is misleading. In prod we drop the relative chip and surface this as
// an absolute build date in the version tooltip instead.
const BUILD_TIME = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '';
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

export function SidebarStatusBar({ wsStatus, dataNotice, agentCounts }: {
  wsStatus?: ConnectionStatus;
  dataNotice?: string | null;
  /** Live Claude Code agent counts: `working` = running/tool-running,
   *  `awaiting` = parked for your input. Undefined hides the chip. */
  agentCounts?: { working: number; awaiting: number };
} = {}) {
  // Slow polling for the status bar (60s)
  const { status } = useSystemStatus(true, 60000);
  const openclawAvailable = useOpenClawAvailable();
  const gatewayOnline = status?.gateway.online ?? false;
  const lastChangeTime = useLastChangeTime();
  // Shared FPS monitor: idle burst-sampling for this number, live 1Hz while the
  // dropdown is open (see useFpsActive below).
  const fps = useFps();
  // Real desktop footprint + CPU. The hook self-guards (null in web mode, and
  // pauses while the window is hidden), so an always-on call is cheap; it polls
  // every 5s in Electron. This is the number that fixes the "status bar says
  // 69 MB but the app is eating way more" gap: 69 MB was just the Bun server's
  // RSS, while `perf.memory.totalMB` sums every Electron process.
  const perf = usePerfMetrics(true, 5000);
  const { updateAvailable } = useServiceWorkerUpdate();
  const [refreshing, setRefreshing] = useState(false);

  const isElectron = !!window.electronAPI?.isElectron;
  const isDev = import.meta.env.DEV;
  // "Last local update" chip. Show it in dev (HMR-tracked) AND when this build
  // is RECENT — the desktop app runs the BUILT bundle (import.meta.env.DEV is
  // false) even while developing locally, so a fresh `vite build` is the only
  // signal that a local change landed. A genuinely shipped release is >24h old,
  // so the chip auto-hides there instead of being a meaningless ever-growing
  // counter (the earlier "30s fa che non è vero" complaint).
  let buildIsRecent = false;
  try {
    // Date.now() is read at render on purpose: this is a one-shot "is the build
    // < 24h old" freshness check, not reactive state. Recomputing it per render
    // is harmless and keeps the chip honest, so the purity rule doesn't apply.
    // eslint-disable-next-line react-hooks/purity
    buildIsRecent = !!BUILD_TIME && (Date.now() - new Date(BUILD_TIME).getTime()) < 24 * 60 * 60 * 1000;
  } catch { buildIsRecent = false; }

  // Total app memory: Electron processes (all renderers/GPU/main) + the Bun
  // server (a separate process, not in getAppMetrics). In web mode there's no
  // per-process data, so we fall back to the server RSS alone — the old number,
  // now honestly scoped by its tooltip.
  const serverMemMB = status?.server.memoryMB ?? null;
  // Optional-chain `memory`: it crosses the IPC boundary, so a renderer running
  // ahead of a not-yet-rebuilt Electron main (auto-update / partial deploy) sees
  // an old payload without `memory`. `?.memory?.` degrades to the server-only
  // fallback instead of throwing. Every read below is gated on electronMemMB,
  // so a non-null value guarantees perf.memory exists.
  const memMetric = perf?.memory?.metric;
  // Headline = the Electron app's own memory (what Activity Monitor groups as
  // "Topics"). The Bun server is a SEPARATE OS process (shown separately in
  // Activity Monitor too), so it's surfaced in the tooltip, not added in — that
  // keeps this number directly comparable to Activity Monitor's "Topics" row.
  const electronMemMB = perf?.memory?.totalMB ?? null;
  const totalMemMB = electronMemMB !== null ? electronMemMB : serverMemMB;
  const memHigh = electronMemMB !== null ? totalMemMB! > 3072 : (serverMemMB ?? 0) > 512;
  const memTitle = electronMemMB !== null
    ? `App Topics: ${totalMemMB} MB — ${memMetric === 'footprint' ? 'footprint, ≈ Activity Monitor (RSS + memoria compressa + GPU)' : 'memoria residente (RSS)'}\n· renderer ${perf!.memory.rendererMB} · GPU ${perf!.memory.gpuMB} · altri ${perf!.memory.otherMB} MB (${perf!.memory.processCount} processi)\n· server Bun (processo separato): ${serverMemMB ?? '—'} MB`
    : status
      ? `Processo server: ${serverMemMB} MB (heap ${status.server.heapUsedMB} MB) — la memoria totale dell'app è disponibile solo nell'app desktop`
      : '';

  // App version: build-time constant, overridden by the live Electron version
  // when running in the desktop shell (more accurate after an auto-update).
  const [appVersion, setAppVersion] = useState(BUILD_APP_VERSION);
  useEffect(() => {
    const getVersion = window.electronAPI?.app?.getVersion;
    if (typeof getVersion === 'function') {
      getVersion().then(v => { if (v) setAppVersion(v); }).catch(() => {});
    }
  }, []);

  const handleRefresh = async () => {
    // Immediate spin so the click is acknowledged (in Electron the app then
    // relaunches; in web we clear caches + hard-reload).
    setRefreshing(true);
    if (isElectron) {
      // `app` is declared optional on the electron API surface — older
      // builds didn't expose it. Fall through to the web reload path
      // when missing so the button is never inert.
      const relaunch = window.electronAPI?.app?.relaunch;
      if (relaunch) {
        await relaunch();
        return;
      }
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
    // Hard reload (bypass cache)
    window.location.reload();
  };

  const [showStatusDropdown, setShowStatusDropdown] = useState(false);
  const statusBtnRef = useRef<HTMLButtonElement>(null);
  const statusDropdownRef = useRef<HTMLDivElement>(null);

  // Version chip → info + auto-update popover.
  const [showVersionPopover, setShowVersionPopover] = useState(false);
  const versionBtnRef = useRef<HTMLButtonElement>(null);

  // While the dropdown is open, hold the FPS monitor in its live (continuous,
  // 1Hz) cadence so the sparkline updates in real time. It drops back to cheap
  // idle bursts when closed.
  useFpsActive(showStatusDropdown);

  // Close dropdown on outside click or Escape
  useEffect(() => {
    if (!showStatusDropdown) return;
    const h = (e: MouseEvent) => {
      const t = e.target as Node;
      if (statusBtnRef.current?.contains(t) || statusDropdownRef.current?.contains(t)) return;
      setShowStatusDropdown(false);
    };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { setShowStatusDropdown(false); e.stopPropagation(); } };
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k, true);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k, true); };
  }, [showStatusDropdown]);

  return (
    <>
      {/* Horizontal inset = ROW_INSET (was px-3): the bottom bar lines up with
          the sidebar cards, the header, and the tab strip — one inset on every
          sidebar axis. */}
      <div className="flex items-center gap-2 min-h-7 border-t border-app-border flex-shrink-0 bg-app-bg" style={{ paddingInline: ROW_INSET, paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
        {/* Gateway status */}
        <button
          ref={statusBtnRef}
          data-testid="connection-status"
          onClick={() => setShowStatusDropdown(!showStatusDropdown)}
          onMouseEnter={prefetchStatusPanel}
          onFocus={prefetchStatusPanel}
          className={`flex items-center gap-1.5 text-[11px] hover:bg-app-hover rounded px-1 py-0.5 transition-colors min-w-0 overflow-hidden ${showStatusDropdown ? 'bg-app-hover' : ''}`}
          title="Performance & stato sistema — apri per FPS live"
        >
          {openclawAvailable ? (
            <>
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                gatewayOnline ? 'bg-emerald-500' : 'bg-red-500'
              }`} />
              <Wifi size={10} className={gatewayOnline ? 'text-emerald-500' : 'text-red-500'} />
              <span className={gatewayOnline ? 'text-app-text-secondary' : 'text-red-500'}>
                {gatewayOnline ? 'Online' : 'Offline'}
              </span>
              {/* Latency lives only in the dropdown Gateway row, next to its
                  "Refresh / Xs ago" control that discloses the 30s cache age —
                  in the bare bar it looked live but was stale + duplicated. */}
            </>
          ) : (
            <span
              className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${status ? 'bg-emerald-500' : 'bg-app-text-muted/40'}`}
              title={status ? 'Topics server reachable' : 'Topics server unreachable'}
            />
          )}
          {totalMemMB !== null && (
            <span
              className={`text-app-text-muted tabular-nums ${memHigh ? 'text-amber-500' : ''}`}
              title={memTitle}
            >
              {totalMemMB}MB
            </span>
          )}
          {perf && (
            <span
              className={`text-app-text-muted tabular-nums ${perf.cpu.total > 150 ? 'text-amber-500' : ''}`}
              title={`CPU app: ${perf.cpu.total}% (renderer ${perf.cpu.renderer}% · GPU ${perf.cpu.gpu}% · altri ${Math.max(0, perf.cpu.total - perf.cpu.renderer - perf.cpu.gpu)}%) — somma % sui processi, può superare 100% come in Activity Monitor`}
            >
              {perf.cpu.total}%
            </span>
          )}
          {fps > 0 && (
            <span className={`text-app-text-muted tabular-nums ${fps < 30 ? 'text-red-500' : fps < 50 ? 'text-amber-500' : ''}`}>{fps}fps</span>
          )}
        </button>

        {/* Live Claude Code agents: 🤖 = working now (running/tool-running),
            ⏳ = parked awaiting your input. Hidden when neither, matching the
            bar's "only show live signals" convention (fps, ws-status). */}
        {agentCounts && (agentCounts.working > 0 || agentCounts.awaiting > 0) && (
          <span
            data-testid="agent-count"
            className="flex items-center gap-1.5 text-[11px] flex-shrink-0 tabular-nums"
            title={`Agenti Claude Code\n· ${agentCounts.working} al lavoro${
              agentCounts.awaiting ? `\n· ${agentCounts.awaiting} in attesa di una tua risposta` : ''
            }`}
          >
            {agentCounts.working > 0 && (
              <span className="flex items-center gap-0.5 text-emerald-500">
                <Bot size={12} className="animate-pulse" />
                {agentCounts.working}
              </span>
            )}
            {agentCounts.awaiting > 0 && (
              <span className="flex items-center gap-0.5 text-amber-500">
                <Hourglass size={10} />
                {agentCounts.awaiting}
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
              wsStatus === 'offline' ? 'text-red-500' : 'text-amber-600 dark:text-amber-400'
            }`}
            title="Stato connessione realtime al server Topics"
          >
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 animate-pulse ${
              wsStatus === 'offline' ? 'bg-red-500' : 'bg-amber-500'
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
            className="flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400 min-w-0 overflow-hidden"
            title={dataNotice}
          >
            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-amber-500" />
            <span className="truncate">{dataNotice}</span>
          </span>
        )}

        <span className="ml-auto flex-shrink-0 flex items-center gap-1.5 text-[11px] text-app-text-muted tabular-nums whitespace-nowrap">
          {appVersion && (
            <button
              ref={versionBtnRef}
              onClick={() => setShowVersionPopover(v => !v)}
              className={`text-app-text-muted hover:text-app-text-secondary hover:bg-app-hover rounded px-1 -mx-0.5 transition-colors ${showVersionPopover ? 'bg-app-hover text-app-text-secondary' : ''}`}
              title="Info versione e aggiornamenti"
            >
              v{appVersion}
            </button>
          )}
          {isDev && (
            <span
              className="px-1 rounded bg-amber-500/15 text-amber-500 font-medium text-[10px] leading-tight"
              title="Build di sviluppo (Vite dev server / hot reload). In produzione questo badge sparisce."
            >
              dev
            </span>
          )}
          {/* Relative "X fa" = last local update. Shown in dev (HMR-tracked) and
              for a recent local build (the desktop app runs the built bundle even
              while developing). Hidden on a stale shipped release. */}
          {(isDev || buildIsRecent) && (
            <span title={`Ultimo aggiornamento codice: ${lastChangeTime ? formatBuildTime(lastChangeTime) + ' fa' : 'dev'}`}>
              {lastChangeTime ? formatBuildTime(lastChangeTime) : 'dev'}
            </span>
          )}
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className={`p-0.5 rounded hover:bg-app-hover transition-colors ${updateAvailable ? 'text-primary' : 'text-app-text-muted'}`}
            title={isElectron ? 'Riavvia l\'app' : updateAvailable ? 'Aggiornamento disponibile' : 'Ricarica'}
          >
            {/* Distinct glyph from the dropdown's data-refresh (RefreshCw): the
                bar button RESTARTS the app (Electron) — a different, heavier
                action that shouldn't look identical sitting next to it. */}
            {isElectron
              ? <RotateCcw size={10} className={refreshing ? 'animate-spin' : ''} />
              : <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />}
          </button>
        </span>
      </div>

      {/* eslint-disable-next-line react-hooks/refs -- portal is positioned against the status button's live geometry; the rect must be read at render time and re-renders alongside this component so the placement stays in sync */}
      {showStatusDropdown && statusBtnRef.current && createPortal(
        <div
          ref={statusDropdownRef}
          className="glass-surface border border-app-border rounded-lg shadow-lg min-w-[320px]"
          style={{
            position: 'fixed',
            // eslint-disable-next-line react-hooks/refs -- same anchor-geometry read: getBoundingClientRect against the live button node positions the fixed dropdown above it
            bottom: window.innerHeight - statusBtnRef.current.getBoundingClientRect().top + 4,
            // eslint-disable-next-line react-hooks/refs -- same anchor-geometry read for horizontal placement
            left: statusBtnRef.current.getBoundingClientRect().left,
            zIndex: 9999,
          }}
        >
          {/* Performance block — non-lazy so the dropdown opens instantly with
              the live FPS history; the heavier system panel streams in below. */}
          <PerfSection />
          <Suspense fallback={<div className="p-3 text-[11px] text-app-text-muted text-center">Caricamento…</div>}>
            <SystemStatusPanel enabled />
          </Suspense>
        </div>,
        document.body
      )}

      {showVersionPopover && (
        <VersionPopover
          anchorEl={versionBtnRef.current}
          appVersion={appVersion}
          isDev={isDev}
          buildDate={BUILD_TIME ? formatBuildDate(BUILD_TIME) : ''}
          onClose={() => setShowVersionPopover(false)}
        />
      )}
    </>
  );
}
