/**
 * Leggere la decisione presa su un piano proposto.
 *
 * Le etichette e il testo della domanda sono un CONTRATTO fra chi la pone (il
 * server, a fine turno — `server/lib/plan-approval.ts`) e chi la interpreta (la
 * riga del tool, che deve capire se far ripartire il lavoro). Vivono qui perché
 * scritte due volte divergerebbero in silenzio: il pannello continuerebbe a
 * comparire e il bottone smetterebbe di fare qualcosa, senza un solo errore.
 */

export const PLAN_APPROVE_LABEL = 'Approva ed esegui';
export const PLAN_REJECT_LABEL = 'Rifiuta e riprova';
export const PLAN_APPROVAL_QUESTION = 'Approvo questo piano?';

type AnswerLike = { kind?: string; answers?: Record<string, string> };

/** `true` approvato, `false` rifiutato, `null` se non è una decisione su un piano. */
export function planDecisionFrom(response: AnswerLike): boolean | null {
  if (response?.kind !== 'questions') return null;
  const entry = Object.entries(response.answers ?? {}).find(
    ([q]) => q.trim() === PLAN_APPROVAL_QUESTION,
  );
  if (!entry) return null;
  return entry[1]?.trim() === PLAN_APPROVE_LABEL;
}
