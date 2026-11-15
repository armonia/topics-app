import { validateOutbound } from "../shared/ws-outbound";

/**
 * v3 foundations WS-01 outbound validation hook. Runs in DEV mode only —
 * zero overhead in production. Catches server-side bugs that emit malformed
 * payloads at the source instead of letting clients discover them.
 *
 * For types not registered in `OUTBOUND_SCHEMAS`, this is a no-op.
 * Migration is incremental: add schemas as types stabilize.
 */
export function devValidateOutbound(message: object): void {
  if (process.env.NODE_ENV === 'production') return;
  const result = validateOutbound(message);
  if (!result.ok) {
    // La console È la funzione: questo ramo esiste solo fuori produzione
    // (guardia sopra) e il suo unico scopo è far vedere allo sviluppatore il
    // broadcast malformato mentre lo scrive. Passarlo al logger strutturato lo
    // seppellirebbe dove nessuno lo guarda durante lo sviluppo, che è l'unico
    // momento in cui serve.
    console.warn(`[WS:outbound] Malformed broadcast — ${result.error}`, message);
  }
}
