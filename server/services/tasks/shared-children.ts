/**
 * Parked and in-flight children of a card: the counts and probes the gates read.
 */

import type { Database } from "bun:sqlite";
import type { TaskService } from "../tasks";
import { REQUEUE_PARKED_LABEL, ARCHIVE_PARKED_LABEL, PROMOTE_PARKED_LABEL } from "../../../shared/board";
import { CHILD_AGENT_COMING } from "../../lib/task-timer-reads";
import type { SharedCore } from "./shared-core";

export type SharedChildren = ReturnType<typeof createSharedChildren>;

export function createSharedChildren(db: Database, { getTaskRow, now }: SharedCore) {


/**
   * Quanti figli diretti aperti (non chiusi, non archiviati) ha il task.
   *
   * È il predicato del cancello su `done`, e la card in review lo legge per dire
   * PERCHÉ approvarla non la chiuderebbe. Uno solo, non due: se il conto e il
   * cancello divergessero, la card direbbe «pronta» su un `done` che il server
   * rifiuta — cioè esattamente la bugia che quel chip esiste per togliere.
   */
  function countOpenChildren(taskId: string): number {
    const r = db.query(
      "SELECT COUNT(*) AS c FROM tasks WHERE parent_task_id = ? AND archived = 0 AND status != 'done'",
    ).get(taskId) as any;
    return r?.c ?? 0;
  }


/** True when the task has non-done, non-archived direct children. */
  function hasActiveChildren(taskId: string): boolean {
    return countOpenChildren(taskId) > 0;
  }


/**
   * Figli che qualcuno sta davvero lavorando o sta per lavorare.
   *
   * LA DOMANDA È «ARRIVA UN TURNO CHE MUOVA QUESTO FIGLIO?», e la risposta non è
   * la colonna in cui sta. Uno step non lo dispaccia MAI nessuno da solo (il
   * tick lista `rootsOnly`): la checklist la muove soltanto l'agente del padre
   * dentro il proprio turno. Quindi un figlio in **todo** sotto un padre senza
   * turno è fermo esattamente quanto uno in **backlog** — e contarlo «in volo»
   * mandava il padre ad aspettarlo per sempre, dieci minuti alla volta.
   * Misurato il 13/08: sette padri, ventuno card ferme sotto la soglia, e
   * nessuna colonna che lo dicesse.
   *
   * In volo restano `in_progress` e `review` (lì una mossa c'è, ed è visibile) e
   * qualunque figlio col PROPRIO chip di dispatch attivo, che si muove da sé.
   *
   * NON è la definizione dei cancelli su `done` e sull'approvazione: là un
   * sottotask fermo blocca eccome, ed è voluto (un epic non è finito perché un
   * pezzo è stato rimandato). Serve solo a distinguere «aspetta» da «non
   * aspetterà mai nessuno».
   */
  function hasChildrenInFlight(taskId: string): boolean {
    const r = db.prepare(
      "SELECT COUNT(*) AS c FROM tasks WHERE parent_task_id = ? AND archived = 0 AND status != 'done'" +
        `   AND (status IN ('in_progress','review') OR COALESCE(dispatch_state, '') IN (${CHILD_AGENT_COMING}))`,
    ).get(taskId) as any;
    return (r?.c ?? 0) > 0;
  }


/**
   * LO STEP HA LAVORO SUO, o e' solo una riga del titolo del padre?
   *
   * E' la differenza che decide fra le due uscite giuste, e il dato c'e' gia'
   * addosso alla riga: una sessione assegnata, dei tentativi spesi, del tempo
   * d'agente, un commit consegnato, oppure un commento che non sia una nota di
   * sistema. Uno step con una di queste tracce e' lavoro cominciato o descritto
   * da qualcuno, e buttarlo perde la lista di cio' che restava da fare; uno
   * step nudo, creato e mai toccato, e' la decomposizione del titolo e
   * archiviarlo non toglie niente a nessuno.
   *
   * Serve a SUGGERIRE, non a decidere: la board ordina i bottoni e lo scrive
   * nella domanda, la scelta resta di chi rivede.
   */
  const CHILD_OWN_WORK_SQL =
    "(CASE WHEN t.assigned_topic_id IS NOT NULL OR t.dispatch_attempts > 0 OR t.agent_ms > 0" +
    "        OR COALESCE(t.delivery_commit, '') <> ''" +
    "        OR EXISTS (SELECT 1 FROM task_comments c WHERE c.task_id = t.id AND c.author <> 'system')" +
    "      THEN 1 ELSE 0 END)";


function parkedChildren(taskId: string): Array<{ id: string; text: string; status: string; own_work: number }> {
    return db.prepare(
      `SELECT t.id, t.text, t.status, ${CHILD_OWN_WORK_SQL} AS own_work FROM tasks t` +
        "  WHERE t.parent_task_id = ? AND t.archived = 0" +
        `   AND t.status IN ('backlog','todo') AND COALESCE(t.dispatch_state, '') NOT IN (${CHILD_AGENT_COMING})` +
        "  ORDER BY t.created_at",
    ).all(taskId) as any;
  }


/**
   * La domanda sui parcheggiati è GIÀ sulla card, e ancora senza risposta?
   *
   * Serve solo al padre che sta in review, dove la domanda si posa nel thread
   * senza muovere la card: lì non c'è nessun `delivered_reason` a fare da
   * marchio, e senza questo controllo la stessa domanda tornerebbe a ogni
   * figlio che chiude.
   *
   * Il confronto è con l'ultimo movimento dei figli parcheggiati, non con
   * l'orologio: una domanda più vecchia del parcheggio più recente parla di
   * una configurazione che non c'è più, e va rifatta. Rispondere ai due
   * bottoni muove i figli, quindi la risposta si vede da qui senza bisogno di
   * registrarla altrove.
   */
  function parkedQuestionStillStanding(parentId: string): boolean {
    const r = db.prepare(
      `SELECT 1 FROM task_comments
        WHERE task_id = ? AND author = 'system' AND content LIKE ?
          AND created_at >= COALESCE(
            (SELECT MAX(updated_at) FROM tasks
              WHERE parent_task_id = ? AND archived = 0 AND status = 'backlog'), '')
        LIMIT 1`,
    ).get(parentId, `%${REQUEUE_PARKED_LABEL}%`, parentId);
    return !!r;
  }


/**
   * IL VERSO OPPOSTO, che mancava. `parkedChildRaisedStall` guarda il padre
   * quando un figlio ENTRA in backlog; qui lo si guarda quando un figlio ne
   * ESCE per sempre, chiuso o archiviato. Nessuna porta lo faceva, e la
   * conseguenza si misura: il 13/08 tre padri fermi con `probe:stalls`, due
   * dei quali erano consegne vere dell'agente dell'11/08 che portavano ancora
   * addosso il chip «in attesa» dei figli, e una finestra di rinvio scaduta da
   * due giorni. Chiudere l'ultimo figlio non ridava un turno a nessuno.
   *
   * Si fa qualcosa solo quando al padre non resta NIENTE in volo: finché un
   * figlio si muove, il padre non è fermo e non è affar nostro.
   *
   * Quattro esiti, e la differenza è cosa resta e dove sta il padre:
   *  - checklist finita, padre fermo in `todo` con la finestra dei sottotask:
   *    la finestra si azzera e il tick lo riprende al giro dopo invece che
   *    dieci minuti più tardi. È il turno restituito.
   *  - checklist finita, padre in `review`: lo stato NON si tocca, perché lì
   *    c'è una decisione umana in attesa e adesso approvare funziona davvero.
   *    Si toglie solo il chip stantio, che dice di aspettare figli che non
   *    esistono più.
   *  - restano solo parcheggiati e il padre non è in review: `askParkedChildren`,
   *    che fa già tutto (domanda, review, due bottoni).
   *  - restano solo parcheggiati e il padre è GIÀ in review: la domanda si posa
   *    nel thread e basta. Muoverlo scriverebbe `delivered_by = 'system'` sopra
   *    una consegna vera, e sulla card quella è la riga che dice al reviewer se
   *    sotto c'è un deliverable.
   */
  function childLeftFlight(parentId: string, by: string, svc: TaskService): void {
    try {
      const parent = getTaskRow(parentId);
      if (!parent || parent.archived === 1 || parent.status === "done") return;
      if (hasChildrenInFlight(parentId)) return;
      const ts = now();
      // Il chip «in attesa» va tolto solo se non sta aspettando qualcos'ALTRO.
      // `wait_reason` è l'attesa dichiarata dall'agente (`deferForWait`): quella
      // resta. La finestra invece si azzera anche se è ancora aperta, ed è tutto
      // il punto: erano dieci minuti presi per aspettare i figli, i figli non ci
      // sono più, e aspettarli ancora sono turni pagati per niente.
      const staleWaitChip = parent.dispatch_state === "waiting" && !parent.wait_reason;
      const clearWaitChip = () => {
        db.prepare(
          `UPDATE tasks SET dispatch_state = NULL, dispatch_error = NULL,
              dispatch_deferred_until = NULL, updated_at = ? WHERE id = ?`,
        ).run(ts, parentId);
      };

      if (!hasActiveChildren(parentId)) {
        if (staleWaitChip) clearWaitChip();
        return;
      }

      if (parent.status !== "review") { svc.askParkedChildren({ taskId: parentId, by }); return; }
      // Una card che porta già una domanda viva non ne riceve una seconda: due
      // domande sulla stessa card non sono più informazione, sono rumore, e il
      // reviewer non sa a quale delle due sta rispondendo.
      if (parent.dispatch_state === "needs_input") return;
      if (parkedQuestionStillStanding(parentId)) return;
      const parked = parkedChildren(parentId);
      if (parked.length === 0) return;
      const elenco = parked.map((c) => `«${c.text.length > 60 ? `${c.text.slice(0, 59)}…` : c.text}»`).join(", ");
      // Stesso suggerimento di `askParkedChildren`, e per la stessa ragione: la
      // domanda si posa in un thread, non su una card che si muove, ma chi la
      // legge ha lo stesso bisogno di sapere quali step hanno lavoro sotto.
      const withWork = parked.filter((c) => c.own_work === 1).length;
      svc.addComment({
        taskId: parentId, author: "system",
        content:
          `Chiuso l'ultimo sottotask in lavorazione, e restano ${parked.length} passi parcheggiati in backlog (${elenco}): ` +
          `nessun dispatcher li prende da solo, e con un sottotask aperto questa card non si può approvare. ` +
          (withWork > 0
            ? `${withWork} hanno lavoro proprio: promuoverli a task li rende servibili dalla coda. `
            : `Nessuno ha lavoro proprio: sono la decomposizione del titolo. `) +
          `Li promuovo a task, li rimetto in coda, o archivio ciò che non serve più?`,
        questionOptions: withWork > 0
          ? [PROMOTE_PARKED_LABEL, REQUEUE_PARKED_LABEL, ARCHIVE_PARKED_LABEL]
          : [ARCHIVE_PARKED_LABEL, PROMOTE_PARKED_LABEL, REQUEUE_PARKED_LABEL],
      });
      if (staleWaitChip) clearWaitChip();
    } catch { /* un avviso non fa mai fallire la chiusura di una card */ }
  }
  return {
    CHILD_OWN_WORK_SQL,
    childLeftFlight,
    countOpenChildren,
    hasActiveChildren,
    hasChildrenInFlight,
    parkedChildren,
    parkedQuestionStillStanding,
  };
}
