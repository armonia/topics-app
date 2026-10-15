import { useCallback, useEffect, useState } from 'react';
import { coalescedFetch } from '../lib/coalesceFetch';
import type { HealthSubsystem } from '../../../shared/system-health';

interface SystemHealth {
  checkedAt: string;
  subsystems: HealthSubsystem[];
}

export function useSystemHealth(enabled = true, intervalMs = 30000) {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const response = await coalescedFetch('/api/system/health', { priority: 'low' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setHealth(await response.json() as SystemHealth);
      setError(null);
    } catch {
      setError('Stato sottosistemi non disponibile.');
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const id = setInterval(() => { if (!document.hidden) void refresh(); }, intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs, refresh]);

  return { health, error, refresh };
}
