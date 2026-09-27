/**
 * The installation's counts, for the user card.
 *
 * ── WHY THE NUMBERS COME FROM THE SERVER AND NOT FROM THE CLIENT'S SIGNALS ──
 * The Discord presence publishes the same snapshot. Counted here from the
 * client's own Sets, the two readings would part at the first edge case, and
 * the wrong one would be the one on screen all day. The server counts once
 * (`computePresenceCounts`) and serves both the same numbers.
 *
 * ONE EXCEPTION, AND IT IS THE CARD'S: the number at work. The card shows it as
 * a badge counted from the agent rows its menu lists, background work included
 * (BGVIS-03), and the route's `workingSessions` leaves that work out by
 * construction. So this hook hands back the counts and the card composes the
 * phrase (`presenceSummary`) with its own working number: one number on one
 * card, whatever the Discord profile says from the route's.
 *
 * ── PERCHE' UNA ROTTA A PARTE E NON `useSystemStatus` ───────────────────────
 * `/api/system/status` fa una scansione `ps` della flotta: la barra la chiede
 * ogni 60 secondi, ed e' giusto cosi'. Un riepilogo con un minuto di ritardo
 * dice «3 al lavoro» quando hanno gia' finito. `/api/system/presence` sono tre
 * COUNT indicizzati, quindi si puo' chiedere ogni pochi secondi.
 *
 * La finestra nascosta non chiede niente (stessa regola di `useSystemStatus`):
 * un riepilogo che nessuno guarda non vale un giro di rete, e al ritorno si
 * rilegge subito invece di mostrare il valore di prima.
 */
import { useEffect, useState } from 'react';
import type { PresenceCounts } from '../../../shared/presence-phrase';

const INTERVALLO_MS = 8000;

/**
 * The counts this device last drew. They feed the digits at the foot of the
 * sidebar, and digits that arrive with the first poll (300-1200 ms after the
 * first paint) change the width of the chip that carries them: measured on a
 * reload, 2026-09-03, the two chips beside it slid 8 px. The poll still
 * replaces the cache as soon as it answers.
 */
const COUNTS_CACHE_KEY = 'topics-presence-counts-cache';
function readCachedCounts(): PresenceCounts | null {
  try {
    const raw = localStorage.getItem(COUNTS_CACHE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as PresenceCounts) : null;
  } catch {
    return null;
  }
}
function rememberCounts(counts: PresenceCounts): void {
  try { localStorage.setItem(COUNTS_CACHE_KEY, JSON.stringify(counts)); } catch { /* storage denied: the poll still draws them */ }
}

interface PresenceSummaryState {
  counts: PresenceCounts | null;
}

export function usePresenceSummary(enabled = true, intervalMs = INTERVALLO_MS): PresenceSummaryState {
  const [counts, setCounts] = useState<PresenceCounts | null>(readCachedCounts);

  useEffect(() => {
    if (!enabled) return;
    let vivo = true;

    const leggi = async () => {
      if (!vivo || document.hidden) return;
      try {
        const res = await fetch('/api/system/presence');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as PresenceCounts;
        rememberCounts(data);
        if (vivo) setCounts(data);
      } catch {
        // Il server irraggiungibile ha gia' il suo segnale in questa barra (il
        // pallino di connessione): spegnere anche la riga la farebbe sparire e
        // riapparire a ogni singhiozzo di rete. Si tiene l'ultimo conteggio.
      }
    };

    void leggi();
    const id = setInterval(() => { void leggi(); }, intervalMs);
    const onVisibility = () => { if (!document.hidden) void leggi(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      vivo = false;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, intervalMs]);

  return { counts };
}
