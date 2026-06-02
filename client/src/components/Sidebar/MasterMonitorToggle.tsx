/**
 * MasterMonitorToggle — small on/off control for the periodic attention
 * monitor, sitting next to the sidebar "Master" button.
 *
 * The monitor is OFF by default and NEVER auto-starts (interactive-claude-
 * primitive); the user turns it on here. When on, the server periodically
 * pings `master:digest` (free, model-less) → surfaced as a toast.
 *
 * Self-contained state (fetch on mount + optimistic toggle) so it doesn't
 * touch TopicTree's render path.
 */
import { useEffect, useState } from 'react';
import { Activity } from 'lucide-react';
import { masterApi } from '../../lib/api';

export function MasterMonitorToggle() {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    masterApi.getMonitor().then((r) => { if (alive) setEnabled(!!r.enabled); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const toggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    const next = !enabled;
    setEnabled(next); // optimistic
    try {
      const r = await masterApi.setMonitor(next);
      setEnabled(!!r.enabled);
    } catch {
      setEnabled(!next); // revert on failure
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      data-testid="master-monitor-toggle"
      onClick={toggle}
      aria-pressed={enabled}
      title={enabled
        ? 'Monitor attivo — ti avvisa quando una sessione richiede attenzione (clic per spegnere)'
        : 'Monitor spento — clic per avviarlo (ti avvisa periodicamente, gratis)'}
      className={`flex-shrink-0 flex items-center justify-center w-7 h-7 rounded transition-colors ${
        enabled
          ? 'text-emerald-400 hover:text-emerald-300 hover:bg-app-hover'
          : 'text-app-text-muted/50 hover:text-app-text-muted hover:bg-app-hover'
      }`}
    >
      <Activity size={13} className={enabled ? 'animate-pulse' : ''} />
    </button>
  );
}
