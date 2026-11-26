/**
 * The codes behind a check's sentence (MACHINE-09): the Italian `detail` stays
 * for the tray and the alerts, and `msgs` carries the same sentence as codes
 * and parameters for the client to word in its own language.
 */
import type { CheckKey, CheckMsg, CheckStatus, SecurityCheck } from "../../shared/machine-health";

/** The reason codes the client words in its own language (`security.why.*`). */
export const WHY_CODE: Record<string, string> = {
  "comando non disponibile": "missing",
  "nessuna risposta in tempo": "timeout",
  "permessi insufficienti": "denied",
  "lettura non riuscita": "failed",
  "risposta non riconosciuta": "unrecognized",
  "nessun registro": "noLog",
  "registri non leggibili da questo utente": "logsUnreadable",
  "XProtect non trovato": "noXprotect",
  "nessuna correzione di sicurezza registrata": "noHotfix",
};

/** A check whose sentence the client composes from `code` and its parameters; `detail` stays the Italian text the tray and the alerts read. */
export function coded(key: CheckKey, status: CheckStatus, detail: string, ...msgs: CheckMsg[]): SecurityCheck {
  return { key, status, detail, msgs };
}
