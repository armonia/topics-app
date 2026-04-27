import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Wifi, RefreshCw } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useSystemStatus } from '@/hooks/useSystemStatus';
import { useServiceWorkerUpdate } from '@/hooks/useServiceWorkerUpdate';
import { useOpenClawAvailable } from '@/hooks/useOpenClawAvailable';

declare const __BUILD_TIME__: string;

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

function useFps() {
  const [fps, setFps] = useState(0);
  const framesRef = useRef(0);
  const lastRef = useRef(performance.now());
  const rafRef = useRef(0);

  useEffect(() => {
    const tick = (now: number) => {
      framesRef.current++;
      if (now - lastRef.current >= 1000) {
        setFps(framesRef.current);
        framesRef.current = 0;
        lastRef.current = now;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  return fps;
}

export function SidebarStatusBar() {
  // Slow polling for the status bar (60s)
  const { status } = useSystemStatus(true, 60000);
  const openclawAvailable = useOpenClawAvailable();
  const gatewayOnline = status?.gateway.online ?? false;
  const latency = status?.gateway.latencyMs;
  const lastChangeTime = useLastChangeTime();
  const fps = useFps();
  const { updateAvailable } = useServiceWorkerUpdate();
  const [refreshing, setRefreshing] = useState(false);

  const isElectron = !!window.electronAPI?.isElectron;

  const handleRefresh = async () => {
    if (isElectron) {
      await window.electronAPI!.app.relaunch();
      return;
    }
    setRefreshing(true);
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
      <div className="flex items-center gap-2 h-7 px-3 border-t border-app-border flex-shrink-0 bg-app-bg">
        {/* Gateway status */}
        <button
          ref={statusBtnRef}
          data-testid="connection-status"
          onClick={() => setShowStatusDropdown(!showStatusDropdown)}
          className={`flex items-center gap-1.5 text-[10px] hover:bg-app-hover rounded px-1 py-0.5 transition-colors min-w-0 overflow-hidden ${showStatusDropdown ? 'bg-app-hover' : ''}`}
          title="System Status"
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
              {gatewayOnline && latency !== undefined && (
                <span className="text-app-text-muted">{latency}ms</span>
              )}
            </>
          ) : (
            <span
              className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${status ? 'bg-emerald-500' : 'bg-app-text-muted/40'}`}
              title={status ? 'Topics server reachable' : 'Topics server unreachable'}
            />
          )}
          {status && (
            <span
              className={`text-app-text-muted tabular-nums ${status.server.memoryMB > 512 ? 'text-amber-500' : ''}`}
              title={`heap: ${status.server.heapUsedMB}/${status.server.heapTotalMB} MB`}
            >
              {status.server.memoryMB}MB
            </span>
          )}
          {fps > 0 && (
            <span className={`text-app-text-muted tabular-nums ${fps < 30 ? 'text-red-500' : fps < 50 ? 'text-amber-500' : ''}`}>{fps}fps</span>
          )}
        </button>

        <span className="ml-auto flex-shrink-0 flex items-center gap-1 text-[10px] text-app-text-muted tabular-nums whitespace-nowrap" title={`Last updated ${lastChangeTime ? formatBuildTime(lastChangeTime) + ' ago' : 'dev'}`}>
          {lastChangeTime ? formatBuildTime(lastChangeTime) : 'dev'}
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className={`p-0.5 rounded hover:bg-app-hover transition-colors ${updateAvailable ? 'text-primary' : 'text-app-text-muted'}`}
            title={isElectron ? 'Restart App' : updateAvailable ? 'Update available' : 'Reload'}
          >
            <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </span>
      </div>

      {showStatusDropdown && statusBtnRef.current && createPortal(
        <div
          ref={statusDropdownRef}
          className="bg-surface border border-app-border rounded-lg shadow-lg min-w-[320px]"
          style={{
            position: 'fixed',
            bottom: window.innerHeight - statusBtnRef.current.getBoundingClientRect().top + 4,
            left: statusBtnRef.current.getBoundingClientRect().left,
            zIndex: 9999,
          }}
        >
          <Suspense fallback={<div className="p-3 text-[11px] text-app-text-muted text-center">Loading...</div>}>
            <SystemStatusPanel enabled />
          </Suspense>
        </div>,
        document.body
      )}
    </>
  );
}
