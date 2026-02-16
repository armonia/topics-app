import { useEffect, useRef, useState } from 'react';
import { Cpu, Wifi } from 'lucide-react';
import { useSystemStatus } from '@/hooks/useSystemStatus';
import { useAgents } from '@/hooks/useAgents';
import type { SidebarTab } from '@/types';

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

interface SidebarStatusBarProps {
  onOpenTab?: (tab: SidebarTab) => void;
  onBadgeData?: (badges: Partial<Record<SidebarTab, number | boolean>>) => void;
}

export function SidebarStatusBar({ onOpenTab, onBadgeData }: SidebarStatusBarProps) {
  // Slow polling for the status bar (60s)
  const { status } = useSystemStatus(true, 60000);
  // Background polling for agent count (30s)
  const { activeSessions } = useAgents({ activeMinutes: 120, enabled: true });

  const gatewayOnline = status?.gateway.online ?? false;
  const latency = status?.gateway.latencyMs;
  const fps = useFps();

  // Report badge data to parent
  useEffect(() => {
    onBadgeData?.({
      agents: activeSessions.length || undefined,
    });
  }, [activeSessions.length, onBadgeData]);

  return (
    <div className="flex items-center gap-2 h-7 px-3 border-t border-app-border flex-shrink-0 bg-surface/80">
      {/* Gateway status */}
      <button
        onClick={() => onOpenTab?.('system')}
        className="flex items-center gap-1.5 text-[10px] hover:bg-app-hover rounded px-1 py-0.5 transition-colors"
        title="Gateway status"
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
        {fps > 0 && (
          <span className={`text-app-text-muted tabular-nums ${fps < 30 ? 'text-red-500' : fps < 50 ? 'text-amber-500' : ''}`}>{fps}fps</span>
        )}
      </button>

      <div className="flex-1" />

      {/* Active agents */}
      {activeSessions.length > 0 && (
        <button
          onClick={() => onOpenTab?.('agents')}
          className="flex items-center gap-1 text-[10px] text-primary hover:bg-app-hover rounded px-1 py-0.5 transition-colors"
          title={`${activeSessions.length} active agent${activeSessions.length > 1 ? 's' : ''}`}
        >
          <Cpu size={10} />
          <span>{activeSessions.length} active</span>
        </button>
      )}
    </div>
  );
}
