import { useState, useEffect, useCallback } from 'react';
import type { SessionCostProbe, WSMessage } from '../types';

/**
 * La sonda del costo di una sessione: contesto, chiamate, e il loro PRODOTTO.
 *
 * Vive accanto a `useRealContext` e non dentro, perché risponde a un'altra
 * domanda. Il ring dice quanto ha in pancia il modello — un fattore. Questa
 * dice quanto costa: quel fattore moltiplicato per quante volte glielo si
 * rispedisce. Con 320k in contesto ogni chiamata a un tool costa 320k, e dieci
 * chiamate in un turno fanno 3,2M.
 *
 * Due sorgenti, come il ring:
 *  • `GET /api/context/cost` al mount e a fine turno — i totali persistiti;
 *  • `stream:context` durante lo streaming, che arriva a OGNI chiamata al
 *    modello: è il battito del moltiplicatore, e aggiorna il contesto senza
 *    tornare al server. Il numero che si muove mentre si lavora è quello, e se
 *    lo si aspettasse dalla fine del turno arriverebbe a spesa fatta.
 *
 * Fuori da `useChat` per lo stesso motivo di `useRealContext`: ricalcolare
 * l'albero dei messaggi a ogni chiamata per aggiornare una riga di testo è il
 * modo di rendere caro un contatore che serve a non spendere.
 */
export function useCostProbe(
  sessionKey: string | null,
  onMessage?: (handler: (msg: WSMessage) => void) => () => void,
  /** Cambia a fine turno: è il segnale per rileggere i totali persistiti. */
  refreshKey?: unknown,
): SessionCostProbe | null {
  // La sessione viaggia INSIEME al dato e si confronta in render: la pane non è
  // keyata sulla sessione (il pannello di progetto scambia la topic sul posto),
  // quindi la sonda di A può atterrare quando si guarda già B. Stessa guardia di
  // `useRealContext`, stesso motivo.
  const [probe, setProbe] = useState<{ key: string; value: SessionCostProbe } | null>(null);

  useEffect(() => {
    if (!sessionKey) return;
    let cancelled = false;
    fetch(`/api/context/cost?sessionKey=${encodeURIComponent(sessionKey)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { cost?: SessionCostProbe | null } | null) => {
        if (cancelled || !data?.cost) return;
        setProbe({ key: sessionKey, value: data.cost });
      })
      .catch(() => { /* la sonda è un'informazione: se non arriva, non si mostra */ });
    return () => { cancelled = true; };
  }, [sessionKey, refreshKey]);

  /**
   * Il contesto vivo, senza tornare al server.
   *
   * `stream:context` scatta a ogni chiamata al modello, quindi qui si aggiorna
   * il MOLTIPLICANDO — e con lui il prodotto proiettato e il prezzo di una
   * chiamata in più. Le chiamate no: quante ne conti in questo turno lo dice
   * `stream:usage`, che la striscia del turno ha già in mano; sommarle anche
   * qui vorrebbe dire tenere due conteggi dello stesso numero.
   */
  const handle = useCallback((msg: WSMessage) => {
    if (msg.type !== 'stream:context') return;
    const used = msg.usage?.used;
    if (!used || used <= 0) return;
    setProbe((prev) => {
      if (!prev || prev.key !== msg.sessionKey) return prev;
      if (prev.value.contextTokens === used) return prev;
      const ratio = prev.value.contextTokens > 0 ? used / prev.value.contextTokens : 1;
      return {
        key: prev.key,
        value: {
          ...prev.value,
          contextTokens: used,
          windowTokens: msg.usage.size || prev.value.windowTokens,
          // Il prezzo di una chiamata scala col contesto: è la stessa tariffa
          // applicata a un prompt più grande.
          perCallUsd: prev.value.perCallUsd * ratio,
          projectedTokens: used * prev.value.toolCalls,
        },
      };
    });
  }, []);

  useEffect(() => {
    if (!onMessage || !sessionKey) return;
    return onMessage(handle);
  }, [onMessage, sessionKey, handle]);

  return probe && probe.key === sessionKey ? probe.value : null;
}
