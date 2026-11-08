import { hasPlanApproveOption, parseQuestionBlock, type TaskComment } from '../../lib/board';

/**
 * QUALE commento è il piano di una card — e quando NON c'è nessun piano.
 *
 * Il task lo PUNTA (`planCommentId`, scritto dal server quando il piano arriva
 * secondo protocollo): non è «l'ultimo commento non-utente», euristica che su
 * 13 task piano-prima sbagliava 13 volte su 13, perché bastava una rettifica
 * dopo il piano per prenderne il posto.
 *
 * LA RICADUTA HA UN CONFINE, e questo è il pezzo nuovo. Serve ai task nati
 * PRIMA del puntatore: stessa regola applicata a posteriori, cioè l'ultimo
 * commento dell'agente le cui opzioni offrono l'approvazione del piano. Ma su
 * un task FINITO quella pesca riporta a galla la domanda di un altro momento —
 * il difetto segnalato era «un task mostra un piano di due righe che non serve
 * a niente», e sono esattamente quelle: card vecchie, senza puntatore, chiuse
 * da un pezzo. Misurato il 14/08: 17 card con `planFirst` e nessun puntatore, e
 * 14 di quelle sono `done`.
 *
 * Su una card chiusa il piano è STORIA e la storia sta nel thread, dove non
 * finge di essere una decisione da prendere. Il pannello resta dove il piano
 * conta ancora: finché la card è aperta, o finché il server lo punta per nome.
 */
export function pickPlanComment(
  task: { planFirst: boolean; planCommentId?: string | null; status: string } | null | undefined,
  speech: TaskComment[],
): TaskComment | null {
  if (!task?.planFirst) return null;
  if (task.planCommentId) {
    const byId = speech.find((c) => c.id === task.planCommentId);
    if (byId) return byId;
  }
  // Senza puntatore la ricaduta vale solo su una card ancora viva.
  if (task.status === 'done' || task.status === 'archived') return null;
  return [...speech].reverse().find((c) => (
    c.author !== 'user' && c.author !== 'system'
    && hasPlanApproveOption(parseQuestionBlock(c.content)?.options ?? [])
  )) ?? null;
}
