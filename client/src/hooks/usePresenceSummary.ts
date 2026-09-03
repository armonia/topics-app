/**
 * Il riepilogo di cosa sta succedendo, per la barra di stato.
 *
 * ── PERCHE' I NUMERI ARRIVANO DAL SERVER E NON DAI SEGNALI DEL CLIENT ───────
 * La stessa fotografia la pubblica la presence Discord. Se la barra la
 * calcolasse per conto suo dai propri Set, le due letture divergerebbero al
 * primo caso di bordo — e quella sbagliata sarebbe quella sotto gli occhi tutto
 * il giorno. Il server conta una volta (`computePresenceCounts`) e serve gli
 * stessi quattro numeri a entrambe.
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
import { presenceSummary, type PresenceCounts } from '../../../shared/presence-phrase';
import { useLocale } from './useT';

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
  /** La riga gia' composta, nella lingua dell'interfaccia. `null` = non c'e'
   *  niente da dire (ed e' lo stesso caso in cui la presence si pulisce). */
  summary: string | null;
}

export function usePresenceSummary(enabled = true, intervalMs = INTERVALLO_MS): PresenceSummaryState {
  const [counts, setCounts] = useState<PresenceCounts | null>(readCachedCounts);
  const locale = useLocale();

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

  return { counts, summary: counts ? presenceSummary(counts, locale) : null };
}
