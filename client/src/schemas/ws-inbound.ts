/**
 * Validazione dei frame WS in ARRIVO dal server.
 *
 * Non è più uno specchio. Fino al 29/07 questo file ridefiniva a mano 26 dei
 * tipi che il server emette, con in testa un "KEEP IN SYNC with
 * server/schemas/ws-outbound.ts": due registri per lo stesso filo, quindi
 * deriva garantita — e infatti divergevano (il client accettava un
 * `topic:switch` senza `fromSessionKey`, campo che il server manda SEMPRE).
 *
 * Ora il registro è UNO SOLO, in `shared/ws-outbound.ts`, importabile da
 * entrambi i progetti TS senza violare il confine composite (TS6307). Questo
 * modulo resta solo per dare al contratto il NOME giusto dal punto di vista del
 * client: ciò che per il server è "outbound", qui è "inbound".
 *
 * Aggiungere un tipo = aggiungerlo allo schema condiviso. Qui non c'è niente
 * da tenere in sincronia, e non deve tornarci.
 */
import {
  validateOutbound,
  isRegisteredOutboundType,
  REGISTERED_OUTBOUND_TYPES,
  type ValidationResult,
} from '../../../shared/ws-outbound';

/** I tipi che il server sa mandare — cioè quelli che il client può ricevere. */
export const REGISTERED_INBOUND_TYPES = REGISTERED_OUTBOUND_TYPES;

export type InboundValidationResult = ValidationResult;

/**
 * Valida un frame in arrivo. `ok: true` per i tipi senza schema (passthrough,
 * identico al lato server), `ok: true` per i tipi registrati che passano,
 * `ok: false` con l'errore Zod qualificato per path altrimenti.
 *
 * Il fallimento non è fatale in produzione: chi chiama logga e SCARTA il frame,
 * invece di far esplodere l'albero React — stesso contratto di degradazione
 * graziosa del lato server.
 */
export function validateInbound(msg: unknown): InboundValidationResult {
  return validateOutbound(msg);
}

export function isRegisteredInboundType(type: string): boolean {
  return isRegisteredOutboundType(type);
}
