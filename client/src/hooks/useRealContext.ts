import { useState, useEffect, useRef, useCallback } from 'react';
import type { ContextUsage, WSMessage } from '../types';

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
  const [usage, setUsage] = useState<ContextUsage | null>(null);

  // Guardia di staleness: la pane NON è keyata sulla sessione (il pannello di
  // progetto scambia la topic attiva sul posto), quindi una fetch lenta per A
  // può atterrare quando l'utente è già su B — e mostrerebbe il contesto di A
  // sotto la chat di B.
  const keyRef = useRef(sessionKey);
  keyRef.current = sessionKey;

  useEffect(() => {
    setUsage(null);
    if (!sessionKey) return;
    let cancelled = false;
    const key = sessionKey;
    fetch(`/api/context/live?sessionKey=${encodeURIComponent(key)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { context?: ContextUsage | null } | null) => {
        if (cancelled || keyRef.current !== key) return;
        if (data?.context) setUsage(data.context);
      })
      .catch(() => { /* il ring è un'informazione: se non arriva, non si mostra */ });
    return () => { cancelled = true; };
  }, [sessionKey]);

  const handle = useCallback((msg: WSMessage) => {
    if (msg.type !== 'stream:context') return;
    if (msg.sessionKey !== keyRef.current) return;
    const { used, size, percent, level, estimated, model } = msg;
    setUsage({ used, size, percent, level, estimated, ...(model ? { model } : {}) });
  }, []);

  useEffect(() => {
    if (!onMessage || !sessionKey) return;
    return onMessage(handle);
  }, [onMessage, sessionKey, handle]);

  return usage;
}

/**
 * `148231` → `148k`. Sotto i mille resta il numero pieno.
 * Le soglie sono spostate di mezza unità (999_500, 9_950_000) perché
 * l'arrotondamento viene PRIMA del suffisso: con il taglio a 1_000_000 netto,
 * 999_999 sarebbe diventato "1000k".
 */
export function formatTokens(n: number): string {
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(n >= 9_950_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}
