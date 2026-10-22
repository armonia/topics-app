import { useCallback, useEffect, useState } from 'react';
import { coalescedFetch } from '../lib/coalesceFetch';
import type { HealthSubsystem } from '../../../shared/system-health';
import { getSystemHealth } from '../lib/api';
import { useT } from './useT';

interface SystemHealth {
  checkedAt: string;
  subsystems: HealthSubsystem[];
}

export function useSystemHealth(enabled = true, intervalMs = 30000) {
  const tr = useT();
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setHealth(await getSystemHealth((path) => coalescedFetch(path, { priority: 'low' })));
      setError(null);
    } catch {
      setError(tr('systemHealth.unavailable'));
    }
  }, [tr]);

  useEffect(() => {
    if (!enabled) return;
    void Promise.resolve().then(refresh);
    const id = setInterval(() => { if (!document.hidden) void refresh(); }, intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs, refresh]);

  return { health, error, refresh };
}
