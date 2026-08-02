import { useState, useEffect, useCallback } from 'react';
import type { ContextUpdatePayload, ContextUsage, WSMessage } from '../types';
import { formatTokens as sharedFormatTokens } from '../lib/formatTokens';

/**
 * Dal payload sul filo (blocco `usage_update` ACP + presentazione) alla forma
 * piatta che disegna il ring. L'appiattimento sta QUI e solo qui: la UI non
 * deve sapere che esiste un protocollo sotto, e il giorno che ACP aggiunge un
 * campo si tocca questa riga, non i componenti.
 */
function flatten(p: ContextUpdatePayload): ContextUsage {
  return {
    used: p.usage.used,
    size: p.usage.size,
    percent: p.percent,
    level: p.level,
    ...(p.reason ? { reason: p.reason } : {}),
    estimated: p.estimated,
    ...(p.model ? { model: p.model } : {}),
  };
}

/**
 * Il contesto REALE della sessione: quanto era grande il prompt dell'ultima
 * chiamata al modello, contro la finestra di quel modello.
 *
 * Vive fuori da `useChat` di proposito. `stream:context` arriva a ogni
 * chiamata di ogni turno: farlo passare per lo stato della chat vorrebbe dire
 * ricalcolare l'albero dei messaggi (e ogni ChatPane aperta) per aggiornare un
 * cerchietto da 14px. Qui l'unico componente che si ri-renderizza è quello che
 * disegna il ring.
 *
 * Due sorgenti, stessa forma:
 *  • WS `stream:context` — vivo, durante lo streaming;
 *  • `GET /api/context/live` — l'ultima misura persistita, al mount. Senza
 *    questa il ring resterebbe vuoto dopo un reload fino al turno successivo,
 *    cioè proprio quando l'umano si chiede "quanto è piena questa chat?".
 */
export function useRealContext(
  sessionKey: string | null,
  onMessage?: (handler: (msg: WSMessage) => void) => () => void,
): ContextUsage | null {
  // Guardia di staleness: la pane NON è keyata sulla sessione (il pannello di
  // progetto scambia la topic attiva sul posto), quindi una misura di A può
  // atterrare quando l'utente è già su B. La sessione viaggia INSIEME alla
  // misura e si confronta in render: così una misura di un'altra sessione non
  // può comparire nemmeno per un frame, e non serve azzerare lo stato da un
  // effect (che è un giro di render in più, e un `setState` dentro un effect).
  const [measured, setMeasured] = useState<{ key: string | null; usage: ContextUsage } | null>(null);

  useEffect(() => {
    if (!sessionKey) return;
    let cancelled = false;
    fetch(`/api/context/live?sessionKey=${encodeURIComponent(sessionKey)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { context?: ContextUpdatePayload | null } | null) => {
        if (cancelled) return;
        if (data?.context?.usage) setMeasured({ key: sessionKey, usage: flatten(data.context) });
      })
      .catch(() => { /* il ring è un'informazione: se non arriva, non si mostra */ });
    return () => { cancelled = true; };
  }, [sessionKey]);

  const handle = useCallback((msg: WSMessage) => {
    if (msg.type !== 'stream:context') return;
    setMeasured({ key: msg.sessionKey, usage: flatten(msg) });
  }, []);

  useEffect(() => {
    if (!onMessage || !sessionKey) return;
    return onMessage(handle);
  }, [onMessage, sessionKey, handle]);

  return measured && measured.key === sessionKey ? measured.usage : null;
}

/**
 * `148231` → `148k`. Sotto i mille resta il numero pieno.
 * Le soglie sono spostate di mezza unità (999_500, 9_950_000) perché
 * l'arrotondamento viene PRIMA del suffisso: con il taglio a 1_000_000 netto,
 * 999_999 sarebbe diventato "1000k".
 */
// Era l'UNICA delle cinque copie ad azzeccare il confine con i milioni.
// L'algoritmo vive ora in lib/formatTokens, con quel confine calcolato dai
// decimali invece che scritto a mano; questo re-export tiene la firma per i
// suoi chiamanti e per il test che la pinna.
export function formatTokens(n: number): string {
  return sharedFormatTokens(n);
}
