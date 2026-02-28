import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Wifi } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useSystemStatus } from '@/hooks/useSystemStatus';

declare const __BUILD_TIME__: string;

function formatBuildTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h ago`;
    const diffD = Math.floor(diffH / 24);
    return `${diffD}d ago`;
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
  const gatewayOnline = status?.gateway.online ?? false;
  const latency = status?.gateway.latencyMs;
  const fps = useFps();

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
      <div className="flex items-center gap-2 h-7 px-3 border-t border-app-border flex-shrink-0 bg-surface/80">
        {/* Gateway status */}
        <button
          ref={statusBtnRef}
          onClick={() => setShowStatusDropdown(!showStatusDropdown)}
          className={`flex items-center gap-1.5 text-[10px] hover:bg-app-hover rounded px-1 py-0.5 transition-colors ${showStatusDropdown ? 'bg-app-hover' : ''}`}
          title="System Status"
        >
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
          <span className="text-app-text-muted tabular-nums" title={`Build: ${typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 'dev'}`}>
            {typeof __BUILD_TIME__ !== 'undefined' ? formatBuildTime(__BUILD_TIME__) : 'dev'}
          </span>
        </button>

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
