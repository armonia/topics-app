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

/**
 * Where the corrected plan travels, and why it is not an answer.
 *
 * The edited text rides in `metadata`, never in `answers`. The answer is the
 * DECISION, and the row reprints it in full when it summarises who chose what
 * (`Object.values(answers)` in `ToolCallRow`): a whole plan in there would be
 * pasted into a one-line recap. `metadata` is already persisted verbatim by
 * `POST /api/chat/tool-response`, so nothing on the server has to learn a new
 * field.
 */
export const PLAN_EDIT_KEY = 'plan';

type AnswerLike = {
  kind?: string;
  answers?: Record<string, string>;
  metadata?: Record<string, unknown>;
};

/** `true` approvato, `false` rifiutato, `null` se non è una decisione su un piano. */
export function planDecisionFrom(response: AnswerLike): boolean | null {
  if (response?.kind !== 'questions') return null;
  const entry = Object.entries(response.answers ?? {}).find(
    ([q]) => q.trim() === PLAN_APPROVAL_QUESTION,
  );
  if (!entry) return null;
  return entry[1]?.trim() === PLAN_APPROVE_LABEL;
}

/**
 * The plan as the human rewrote it, or `null` when nobody touched it.
 *
 * An empty or blank string is nobody touching it: sending a plan that says
 * nothing would replace the proposal with silence.
 */
export function editedPlanFrom(response: AnswerLike): string | null {
  const raw = response?.metadata?.[PLAN_EDIT_KEY];
  if (typeof raw !== 'string') return null;
  return raw.trim().length > 0 ? raw : null;
}

/**
 * Questa domanda è la scelta su un piano?
 *
 * Serve a due cose: alla barra sopra il composer, per sapere se comparire; e a
 * `answerFromText`, per NON promettere che una riga di prosa possa rispondere.
 * Su un ask normale il testo libero passa verbatim al modello, che lo legge per
 * mestiere. Qui dall'altra parte non c'è nessun modello: la scelta la
 * interpretiamo noi, e fra due opzioni esatte «sì», «vai» o «no direi» sono un
 * indovinello — che si risolverebbe eseguendo un piano che volevi rifiutare.
 */
export function isPlanApprovalSchema(schema: unknown): boolean {
  const s = schema as { kind?: string; questions?: { question?: string }[] } | null;
  if (!s || s.kind !== 'questions') return false;
  return (s.questions ?? []).some((q) => q?.question?.trim() === PLAN_APPROVAL_QUESTION);
}
