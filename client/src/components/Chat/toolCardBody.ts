/**
 * Che cosa una riga di tool ha da MOSTRARE, se aperta.
 *
 * Pure, e fuori da `ToolCards.tsx` perché lì sarebbero export non-componente in
 * un file di componenti (`react-refresh/only-export-components`) — e perché
 * questo è l'unico posto in cui la domanda «c'è un corpo?» ha una risposta sola,
 * valida sia per la card che per il chevron che la apre.
 */

import type { ToolCallDetail } from '../../types';

/**
 * Le istruzioni che una `Skill` ha caricato, o `null` se non ce ne sono.
 *
 * «Launching skill: X» è tutto ciò che la CLI restituisce, e non dice niente
 * che l'intestazione della riga non dica già: per la card equivale al vuoto.
 * I messaggi anteriori alla correzione del provider hanno SOLO quello.
 */
export function skillInstructions(result?: string): string | null {
  const t = result?.trim();
  if (!t || /^Launching skill:/.test(t)) return null;
  return t;
}

/**
 * La riga ha qualcosa da APRIRE?
 *
 * Quasi tutte le card mostrano sempre qualcosa (un percorso, gli argomenti, un
 * comando). Tre no: una `Skill` senza istruzioni, uno `SlashCommand` senza
 * output, e un tool MCP/sconosciuto chiamato senza argomenti e senza risultato.
 * Lì il chevron prometteva un corpo e apriva il vuoto — il click sembrava non
 * funzionare, ed è esattamente com'è stato letto («la skill non apre nulla»).
 */
export function toolCardHasBody(detail: ToolCallDetail, detailBytes?: number): boolean {
  // Il payload della cronologia svuota `output`/`content`/`result` dentro
  // `detail` e lascia sul toolCall il conto dei byte tolti (`detailBytes`).
  // Senza questa riga le tre righe che decidono guardando quelle stringhe
  // leggerebbero il vuoto e concluderebbero «niente da aprire»: il chevron
  // sparirebbe proprio dalle righe che un corpo ce l'hanno, e grosso.
  // Il conto e' la traccia che quel corpo esisteva; il testo si va a prendere
  // all'apertura.
  if (typeof detailBytes === 'number' && detailBytes > 0) return true;
  switch (detail.type) {
    case 'skill':
      return skillInstructions(detail.result) !== null;
    case 'slash_command':
      return !!detail.result;
    case 'mcp':
      return Object.keys(detail.args ?? {}).length > 0 || !!detail.result;
    case 'unknown':
      return Object.keys(detail.raw.args ?? {}).length > 0 || !!detail.raw.result;
    default:
      return true;
  }
}
