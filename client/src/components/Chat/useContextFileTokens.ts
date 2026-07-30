import { useMemo } from 'react';
import type { ContextSource } from '@/lib/api';

/**
 * Token per file di contesto, dai dati STRUTTURATI.
 *
 * Prima questo hook faceva una fetch propria a `/api/context` e poi provava a
 * ricavare i numeri per file da una stringa in PROSA costruita per essere letta
 * da un umano — `"foo.md: ~123 tokens, bar.md: ~456 tokens"` — con una regex e
 * un match per suffisso del nome. Due file con lo stesso basename in cartelle
 * diverse finivano sullo stesso valore, e quando la regex non agganciava niente
 * il fallback DIVIDEVA il totale in parti uguali: numeri inventati, mostrati
 * accanto a ogni pillola come se fossero misure.
 *
 * Il dato vero esiste ed è tipizzato: i blocchi di categoria `file`, con
 * `id = "file:<path assoluto>"` e i loro `tokens`. Arrivano nelle `sources` che
 * `useContextInspector` già scarica per lo stesso componente, quindi qui non
 * serve nemmeno una richiesta: è una proiezione.
 *
 * Un file assente dalla mappa significa "non lo so", e chi disegna deve
 * mostrarlo come tale — non come zero, e non come una media.
 */
export function useContextFileTokens(sources: ContextSource[]): Map<string, number> {
  return useMemo(() => {
    const map = new Map<string, number>();
    for (const s of sources) {
      if (s.category !== 'file') continue;
      const path = s.id.startsWith('file:') ? s.id.slice('file:'.length) : null;
      if (path && typeof s.tokens === 'number') map.set(path, s.tokens);
    }
    return map;
  }, [sources]);
}
