import type { Database } from "bun:sqlite";
import type { ServiceOpts, TaskService } from "../tasks";
import type { createTasksShared } from "./shared";
import { agentAuthorSql } from "../../../shared/comment-author";
import { SAME_TIP_BOUNCE_CAP, TaskServiceError, VISIBLE_PREVIEW_BOUNCE_CAP } from "./shared";
import { type Task } from "../task-shapes";
import { isDeliverySheetPath, isAutoCapturedPreview } from "../../../shared/media-kind";
import { statSync } from "node:fs";

/**
 * SQL for `past_delivery_branches` when `delivery_branch` is about to be
 * overwritten (one `?` = the new branch). SQLite reads the OLD row on the right
 * of every assignment, so the outgoing branch is appended once, never twice,
 * and never when it is the same branch written again.
 */
const REMEMBER_REPLACED_BRANCH =
  "CASE WHEN delivery_branch IS NULL OR delivery_branch = COALESCE(?, '') " +
  "OR instr(' ' || COALESCE(past_delivery_branches, '') || ' ', ' ' || delivery_branch || ' ') > 0 " +
  "THEN past_delivery_branches " +
  "ELSE TRIM(COALESCE(past_delivery_branches, '') || ' ' || delivery_branch) END";

export function createDeliveryMethods(db: Database, _opts: ServiceOpts, shared: ReturnType<typeof createTasksShared>): Pick<TaskService, "deliverToReviewBySystem" | "retirePreview" | "sweepReviewPreviews" | "recordDelivery" | "setDeliveryStat" | "setDeliveryBranch"> {
  const {
    agentAskOnThread,
    duplicatePreviewOf,
    ensureDeliverySheet,
    getTaskRow,
    hasActiveChildren,
    hasFreshAgentComment,
    logStatus,
    markReopened,
    now,
    promoteReviewPreview,
    rejectedPaths,
    writeSystemDeliveryAsk,
    rowToTask,
    uuid,
  } = shared;

/** The list including `path`, without duplicates and without empties. */
  const withRejectedPath = (raw: string | null | undefined, path: string | null | undefined): string[] => {
    const p = (path ?? "").trim();
    const already = rejectedPaths(raw);
    return p && !already.includes(p) ? [...already, p] : already;
  };

/**
   * Promote the agent's last plain comment to `kind = 'delivery'` when the
   * thread holds no delivery at all. Returns true when a row was promoted.
   *
   * The thread stays intact: same row, same text, same author; only the kind
   * changes, which is the one field the card, the sheet and the drawer read to
   * find «what was delivered». Best-effort, like every note on this door.
   */
  function promoteLastAgentWordToDelivery(taskId: string): boolean {
    try {
      const has = db.prepare(
        "SELECT 1 FROM task_comments WHERE task_id = ? AND kind = 'delivery' LIMIT 1",
      ).get(taskId);
      if (has) return false;
      const last = db.prepare(
        `SELECT id FROM task_comments
          WHERE task_id = ? AND ${agentAuthorSql()} AND kind = 'comment' AND TRIM(content) <> ''
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      ).get(taskId) as { id: string } | null;
      if (!last) return false;
      db.prepare("UPDATE task_comments SET kind = 'delivery' WHERE id = ?").run(last.id);
      return true;
    } catch { return false; }
  }

  return {
deliverToReviewBySystem(this: TaskService, { taskId, reason, cause, nextMove, uncommittedFiles, messageId, quietReason, deliveredTip }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      // A done card is never carried back to review by the system: a remote run
      // that reports after the card was closed must not reopen it
      // (`reopenedBy: dispatcher`, measured 12/11 on 17436204). Same rule as `release`.
      if (row.status === "done") return rowToTask(row);
      const ts = now();
      // SAME TIP AS THE ONE SENT BACK, NO WORD FROM THE AGENT: a resumed turn
      // that hands in the commit that was just rejected did no work, and
      // review would open a full CI run on it (13/11, same commit three times).
      // First time: back to todo with the reason. Second: review, flagged, so a
      // person decides instead of the loop going on.
      const sameTip = !!deliveredTip && !!row.prior_commit && deliveredTip === row.prior_commit
        && !hasFreshAgentComment(taskId);
      if (sameTip) {
        const bounces = Number(row.same_tip_bounces ?? 0) + 1;
        if (bounces < SAME_TIP_BOUNCE_CAP) {
          db.prepare(
            `UPDATE tasks SET assigned_topic_id = NULL, assigned_agent_id = NULL,
                status = 'todo', dispatch_state = NULL, dispatch_error = NULL,
                wait_streak = 0, wait_reason = NULL, wait_since = NULL,
                dispatch_deferred_until = NULL, same_tip_bounces = ?, updated_at = ? WHERE id = ?`,
          ).run(bounces, ts, taskId);
          if (row.status !== "todo") logStatus(taskId, row.status, "todo", "dispatcher");
          markReopened(taskId, row.status, "todo", "system", "dispatcher");
          try {
            this.addComment({
              taskId, author: "system", kind: "service", messageId: messageId ?? null,
              content: "Il turno ha riconsegnato lo stesso commit di prima, senza commit nuovi e senza resoconto: non apro la review. Torna in lavorazione: leggi il motivo del rimando, fai le modifiche e commenta cosa hai cambiato.",
            });
          } catch { /* best-effort */ }
          return rowToTask(getTaskRow(taskId));
        }
        db.prepare("UPDATE tasks SET same_tip_bounces = 0 WHERE id = ?").run(taskId);
        try {
          this.addComment({
            taskId, author: "system", kind: "comment",
            content: "Nessun lavoro fatto: anche il secondo turno ha riconsegnato lo stesso commit rimandato, senza resoconto.",
          });
        } catch { /* best-effort */ }
      } else if (Number(row.same_tip_bounces ?? 0) > 0) {
        db.prepare("UPDATE tasks SET same_tip_bounces = 0 WHERE id = ?").run(taskId);
      }
      // LA RIGA SI SCRIVE DOPO LE GUARDIE, non prima. Stava in cima perché così
      // era «l'ultima parola sulla card» — ragione caduta con `ad1516aca`, che
      // garantisce il trasporto dell'ultima parola vera quale che sia la sua
      // posizione. Restava solo il costo: il testo dice «L'ho portato io in
      // review: valuta cosa ha prodotto», ma le due guardie qui sotto possono
      // mandare la card in `todo`. Misurato il 18/08 su `171b787d`: commento
      // alle 03:34:43.585, riga di stato `in_progress→todo` alle 03:34:43.587 —
      // due millisecondi dopo. Su tre giorni, 35 note di questa famiglia: 29
      // seguite da review e SEI da todo; sull'intero storico, 260 note e 87
      // verso todo o backlog.
      //
      // La riga resta nel thread per sempre, e quando la card arriva davvero in
      // review è quella che il reviewer trova: gli dice di valutare una consegna
      // in un momento in cui non ce n'era ancora una. Si scambia «sempre
      // presente, a volte falsa» con «a volte assente, mai falsa» — e solo sulla
      // seconda si può decidere.
      // Un padre con sottotask aperti NON è approvabile (il gate su `done` lo
      // rifiuta), quindi metterlo in review mette in coda all'umano una card su
      // cui non può decidere niente — e ci torna a ogni turno esaurito. Misurato
      // il 10/08: la stessa card rimbalzata in review quattro volte in un'ora,
      // con quattro figli aperti. Il posto giusto è la coda: il lavoro non è
      // finito, e il turno finito non lo rende finito.
      //
      // Ma «aperto» e «lo sta aspettando qualcuno» non sono la stessa cosa: se
      // gli unici figli aperti sono PARCHEGGIATI in backlog, nessun dispatcher
      // li prenderà e il padre aspetterebbe a vuoto per sempre.
      //
      // E quello non è nemmeno un blocco: è una DOMANDA con due risposte
      // (rimettili in coda / archiviali), e le domande si fanno dove l'umano
      // guarda. Parcheggiare il padre in backlog con la spiegazione dentro
      // `dispatch_error` la nascondeva nel drawer di una card in fondo alla
      // colonna del riposo: misurate il 12/08 cinque card ferme così, e nessuna
      // lo diceva a nessuno. `askParkedChildren` la porta in review coi bottoni.
      // `evenIfLive`: qui il turno E' finito — questa funzione la chiama chi lo
      // sta chiudendo — quindi la guardia sul padre vivo non deve mordere.
      const domanda = this.askParkedChildren({ taskId, by: "dispatcher", evenIfLive: true });
      if (domanda) return domanda;
      if (hasActiveChildren(taskId)) {
        // Il tentativo si RESTITUISCE: il turno non è finito per colpa del
        // padre, è finito mentre i figli lavoravano ancora — esattamente come
        // il riavvio del server non è colpa dell'agente. Senza questo, il padre
        // rientra in coda col budget già speso e non verrà reclamato MAI più:
        // niente chip, niente errore, una card che finge di essere in coda.
        // Diciannove così l'11/08, tutte da questo ramo.
        //
        // E il chip lo dice: `waiting` con la ragione, non il nulla che sul
        // board si legge come «fermato a mano».
        //
        // E non rientra SUBITO in coda: senza finestra, il tick lo riprende al
        // giro dopo, il turno finisce di nuovo coi figli ancora aperti, e sono
        // turni pagati per aspettare. Stessa meccanica di `deferForWait`.
        const note = "In attesa dei sottotask ancora aperti: torno in coda e riparto quando hanno finito.";
        const until = new Date(Date.parse(ts) + 10 * 60_000).toISOString();
        // AND THE WAIT SERIES ENDS HERE. This window is not a wait the agent
        // declared: it is the coordinator putting itself back in the queue
        // because its children are still working. Leaving an old series'
        // `wait_since` and `wait_streak` standing under a fresh window makes the
        // outside judge lie twice over - it says "N waits in a row for the same
        // reason" about waits a turn has already closed, and it counts them from
        // an instant that has nothing to do with this one. The price is a
        // `waited_out` park, the one state that reaches a push notification, on
        // a card that is coordinating its own children and would keep working.
        db.prepare(
          `UPDATE tasks SET assigned_topic_id = NULL, assigned_agent_id = NULL,
              dispatch_attempts = MAX(dispatch_attempts - 1, 0),
              status = 'todo', dispatch_state = 'waiting', dispatch_error = ?,
              wait_streak = 0, wait_reason = NULL, wait_since = NULL,
              dispatch_deferred_until = ?, updated_at = ? WHERE id = ?`,
        ).run(note, until, ts, taskId);
        if (row.status !== "todo") logStatus(taskId, row.status, "todo", "dispatcher");
        // La ragione del turno resta scritta — sparire in silenzio sarebbe
        // peggio, e un test lo pinna — ma accompagnata dalla destinazione VERA:
        // questa card non è in review, e nessuno deve valutarla adesso. Servizio,
        // perché su una card in coda è contabilità: chi la riprende è il
        // dispatcher, non un umano.
        if (reason && reason.trim()) {
          try { this.addComment({ taskId, author: "system", kind: "service", content: `${reason}\n\n${note}`, messageId: messageId ?? null }); }
          catch { /* best-effort */ }
        }
        return rowToTask(getTaskRow(taskId));
      }
      // VISIBLE CARD, NO REAL EVIDENCE: this door used to hand Review a
      // generic delivery-sheet diagram for a card labelled `visibile` (it
      // touches client/src), leaving the reviewer nothing to judge "a vista".
      // The agent-driven PATCH already refuses this with `review_needs_preview`
      // (routes/tasks.ts) — but THIS door fires when the turn ends on its own,
      // with no agent left to answer a 409. Same fix as the children guard
      // above: do not finalize into review, send it back for another turn.
      const cardLabels = (db.prepare(
        "SELECT label FROM task_labels WHERE task_id = ?",
      ).all(taskId) as Array<{ label: string }>).map((r) => r.label);
      if (cardLabels.includes("visibile")) {
        const currentPreview = (row.preview_image ?? "").trim();
        if (!currentPreview || isDeliverySheetPath(currentPreview)) {
          // THE BOUNCE HAS A TETTO. Sending the card back to `todo` hands it to
          // the next agent, who has no browser either (kickoff rule on this
          // fleet), hits the same gate and bounces again — measured 11/11: 5
          // cards in 30 minutes, none of them an agent's own turn burning its
          // own budget, all of them this door's requeue. After
          // `VISIBLE_PREVIEW_BOUNCE_CAP` rounds the condition is not "try
          // again", it is "nobody on this board can produce this photo" — a
          // decision for a human, not another turn. `todo` keeps dispatching;
          // `backlog` stops until a person acts (land a headless-browser path,
          // or attach the evidence by hand).
          const bounces = Number(row.visible_preview_bounces ?? 0) + 1;
          const capped = bounces >= VISIBLE_PREVIEW_BOUNCE_CAP;
          // A capped card is NEVER parked in backlog: backlog is for what waits
          // on a person's decision, and nobody picks a parked card up again. It
          // is routed to this machine (the server's own host has the browser)
          // with the reason in plain sight; if it is already pinned here and
          // still bounces, it waits in todo for a retry window instead.
          const alreadyLocal = !!row.stay_local;
          const retryAt = new Date(Date.parse(ts) + 60 * 60_000).toISOString();
          const nota = capped
            ? alreadyLocal
              ? "Card visibile (tocca client/src) ancora senza foto prima/dopo su questa macchina: resta in Todo in attesa, riprovo tra un'ora."
              : `Card visibile (tocca client/src) senza foto prima/dopo dopo ${bounces} giri: i nodi senza browser non possono farla, quindi la instrado su questa macchina, che ha il browser.`
            : "Card visibile (tocca client/src) senza foto prima/dopo: non entra in review così, torna in coda per un altro turno.";
          db.prepare(
            `UPDATE tasks SET assigned_topic_id = NULL, assigned_agent_id = NULL,
                status = 'todo', dispatch_state = ?, dispatch_error = ?,
                wait_streak = 0, wait_reason = NULL, wait_since = NULL,
                dispatch_deferred_until = ?, visible_preview_bounces = ?,
                stay_local = CASE WHEN ? THEN 1 ELSE stay_local END,
                machine_id = CASE WHEN ? THEN NULL ELSE machine_id END,
                updated_at = ? WHERE id = ?`,
          ).run(
            capped && alreadyLocal ? "waiting" : null, nota,
            capped && alreadyLocal ? retryAt : null, bounces,
            capped ? 1 : 0, capped ? 1 : 0, ts, taskId,
          );
          if (row.status !== "todo") logStatus(taskId, row.status, "todo", "dispatcher");
          markReopened(taskId, row.status, "todo", "system", "dispatcher");
          try {
            this.addComment({
              taskId, author: "system", kind: "service",
              content: capped
                ? nota
                : `${nota} Allega update_task(previewImage=<path assoluto>) con la foto prima/dopo, poi richiedi di nuovo lo status review.`,
              messageId: messageId ?? null,
            });
          } catch { /* best-effort */ }
          return rowToTask(getTaskRow(taskId));
        }
      }
      // Qui, e solo qui, la card va DAVVERO in review: è il punto in cui «l'ho
      // portato io in review» smette di essere una previsione e diventa un fatto.
      // PREDICATO review_needs_summary, PORTA DI SISTEMA.
      //
      // PRIMA di cio' che parla all'umano, e non dopo: l'ULTIMA parola del
      // thread e' quella a cui si risponde. Una domanda porta le sue opzioni
      // (`questionOptions`) e il client legge l'ultimo commento; una nota di
      // contabilita' appesa dopo la seppelliva, e sette casi di
      // `tasks.parked-stall.test.ts` sono diventati rossi leggendo `[]` dove
      // c'erano due bottoni. Il rosso era il sintomo: il guasto vero e' che
      // chi apriva la card trovava per ultima una riga di macchina invece
      // della decisione che gli si chiede.
      //
      // Dentro `update()` il predicato BLOCCA (l'agente puo' riprovare). Qui
      // non puo' — il turno e' finito — ma il fatto si ANNOTA: chi rivede sa
      // subito che l'agente non ha dichiarato nulla. Come, e in che ordine,
      // sta scritto sul blocco stesso piu' sotto.
      if (reason && reason.trim()) {
        const testo = nextMove && nextMove.trim() ? `${reason}\n\n${nextMove.trim()}` : reason;
        try { this.addComment({ taskId, author: "system", content: testo, messageId: messageId ?? null, quiet: quietReason === true }); } catch { /* best-effort */ }
      }
      // QUESTA NOTA VA SCRITTA PER ULTIMA, ed è il motivo per cui sta sotto
      // `reason` e non sopra.
      //
      // La card mostra l'ULTIMA parola del thread. Nata prima della chiusura
      // del fan-out, questa riga le finiva sotto — e siccome le due hanno lo
      // stesso timestamp al secondo, a decidere l'ordine era il rowid. A
      // schermo restava «Fan-out chiuso: 3 tentativi, 1 con modifiche», che è
      // contabilità, mentre l'unica riga che spiega PERCHÉ la card è in review
      // senza una parola dell'agente stava nascosta sotto (visto il 20/08 su
      // 235afe11).
      //
      // Ed è `kind: 'comment'`, non più `'service'`: come service la card la
      // scartava (`isThreadSpeech`), quindi era scritta in un thread che
      // nessuno apre. Il primo rimedio che avevo tentato era un cartello
      // generico sulla card — una fascia ambra che diceva «sotto c'è solo
      // cronaca» sopra la cronaca stessa, senza il perché: più rumore di quanto
      // ne togliesse. Meglio far arrivare la frase VERA, che il perché ce l'ha
      // dentro.
      // THE AGENT'S LAST WORD BECOMES THE DELIVERY when nobody declared one.
      //
      // Through `update()` the delivery is declared (`summary` → `kind:
      // 'delivery'`); through this door the turn is over and nothing declares
      // it. Measured on the last 30 done cards: 1 carried a delivery row, 12 had
      // any agent comment at all. The card, the sheet and the drawer all anchor
      // on `kind = 'delivery'`, so the anchor is set here, once, on the row the
      // review gate would have read anyway. Only when there is no delivery yet:
      // a declared one from a previous round is not overwritten.
      promoteLastAgentWordToDelivery(taskId);
      if (!hasFreshAgentComment(taskId)) {
        try {
          this.addComment({
            taskId, author: "system", kind: "comment",
            content: "Consegna senza riassunto: il turno e' finito prima che l'agente commentasse.",
          });
        } catch { /* best-effort */ }
      }
      // Hand to the human: keep assigned_topic_id (a rejection resumes this
      // agent), clear the stale error, chip = needs_input (a decision is wanted).
      // `delivered_by = 'system'`: la card in review deve dire da sé che non è una
      // consegna dell'agente — sotto può non esserci nessun deliverable.
      db.prepare(
        // La serie di attese si chiude qui come si chiude in `update()`: il task
        // è arrivato all'umano, non sta più aspettando niente. Questa porta è a
        // SQL grezzo e non passa da lì, quindi la riga va ripetuta o la serie
        // sopravviverebbe alla consegna.
        // `review_at` per la stessa ragione della serie d'attesa, ed e' lo
        // stesso avvertimento: questa porta non passa da `update()`, quindi
        // senza la riga qui la card arriverebbe in review senza sapere da
        // quando ci sta - e la colonna direbbe «ora» per sempre.
        // `delivery_uncommitted_files` travels WITH the transition, not after
        // it: the sheet is drawn a few lines below, and a number written an
        // instant later would be a number that first drawing never saw.
        "UPDATE tasks SET status = 'review', dispatch_state = 'needs_input', dispatch_error = NULL, " +
          "wait_streak = 0, wait_reason = NULL, wait_since = NULL, review_at = ?, " +
          "delivery_uncommitted_files = ?, prior_uncommitted_files = NULL, " +
          "delivered_by = 'system', delivered_reason = ?, updated_at = ? WHERE id = ?",
      ).run(ts, typeof uncommittedFiles === "number" ? uncommittedFiles : null, cause ?? null, ts, taskId);
      if (row.status !== "review") logStatus(taskId, row.status, "review", "dispatcher");
      markReopened(taskId, row.status, "review", "system", "dispatcher");
      // THE QUESTION OF THIS DELIVERY: the AGENT's last word (not the
      // thread's: this door writes its own notes under it) when it asks the person.
      writeSystemDeliveryAsk(taskId, agentAskOnThread(taskId), nextMove);
      // Open the pending review approval so the review decision flow works, just
      // like an agent-initiated hand-off would.
      try {
        db.prepare(
          `INSERT INTO approvals (id, task_id, requested_by, approval_type, from_status, to_status, status, created_at)
           VALUES (?, ?, 'dispatcher', 'review', ?, 'done', 'pending', ?)`,
        ).run(uuid(), taskId, row.status, ts);
      } catch { /* an existing pending approval is fine */ }
      // THE PREVIEW HERE TOO. In `update()` the edge into review calls it
      // (`patch.status === "review"`); this door did not, so a card delivered by
      // the system stayed without a sheet until the server's BOOT sweep, that is
      // until the next restart. And it is exactly the card that needs one most,
      // because its agent never got the time to tell the story.
      promoteReviewPreview(taskId);
      return rowToTask(getTaskRow(taskId));
    },

/**
     * Ritira l'anteprima e SCRIVE il perché sulla card.
     *
     * Un solo gesto, perché il fatto è uno solo: l'immagine se ne va e la card
     * porta il motivo. Prima il motivo finiva solo in una nota del thread —
     * dove non invecchia, non si corregge e non sa di essere stata superata.
     * Qui si spegne da solo appena qualcuno allega un'anteprima nuova (vedi
     * `update`/`promoteReviewPreview`).
     *
     * AND IT REMEMBERS WHAT IT REJECTED. Taking the image off the card does not
     * take it out of the thread: it stays attached to the comment the card took
     * it from, which is exactly where `promoteReviewPreview` fishes when it
     * finds a card in review with no preview. With no memory the startup sweep
     * put the just-rejected shot back and, since a new preview supersedes a
     * retirement, switched the retirement off too: it did not survive a
     * restart. Measured on 2026-08-23 across four cards in review, all with the
     * note and none with the state.
     */
    retirePreview({ taskId, reason }): Task {
      const row = getTaskRow(taskId);
      if (!row) throw new TaskServiceError("not_found", `task ${taskId} not found`);
      // Una SCHEDA DI CONSEGNA non si ritira: non e' una fotografia falsa, e'
      // il ripiego disegnato dal server. Toglierla riporterebbe la card cieca
      // proprio nel momento in cui l'anteprima viva ha appena fallito, cioe'
      // esattamente il caso per cui la scheda esiste. Il motivo resta scritto
      // (la nota di chi ritira), l'immagine resta.
      if (isDeliverySheetPath(row.preview_image)) return rowToTask(row);
      db.prepare(
        "UPDATE tasks SET preview_image = NULL, preview_rejected = ?, preview_retired_at = ?, preview_retired_reason = ?, updated_at = ? WHERE id = ?",
      ).run(
        JSON.stringify(withRejectedPath(row.preview_rejected, row.preview_image)),
        now(), reason.trim() || null, now(), taskId,
      );
      return rowToTask(getTaskRow(taskId));
    },

sweepReviewPreviews(): number {
      try {
        // THE SHEETS ALREADY DRAWN TOO, not just the blind cards.
        //
        // The sheet shows the diffstat, and the diffstat lands AFTER: the sheet
        // is born on the transition into review, the numbers are filled in by
        // the backfill pass half an hour later. A card that already had its
        // sheet did not enter this sweep, so it kept the first drawing for ever
        // — measured 2026-09-01 on `dec39cd3`: zero files and zero lines both
        // ways, against the 4 files and +157 lines the column actually held.
        //
        // Redrawing is safe by construction and costs one write per card:
        // `ensureDeliverySheet` writes only over emptiness or over a previous
        // sheet, and stops in front of somebody's real evidence.
        // `promoteReviewPreview` stays the first branch for blind cards: the
        // sheet is the last one, not the first.
        const rows = db.prepare(
          "SELECT id, COALESCE(TRIM(preview_image), '') AS preview FROM tasks " +
          "WHERE status = 'review' AND COALESCE(archived, 0) = 0",
        ).all() as Array<{ id: string; preview: string }>;
        let coperte = 0;
        for (const r of rows) {
          if (r.preview) {
            // A sheet gets REDRAWN (its numbers may have changed), somebody's
            // evidence is left alone. Neither is a «rescued» card: the number
            // this function returns ends up in a log line saying how many BLIND
            // cards have a preview again, and counting redraws would make it
            // lie at every boot.
            if (isDeliverySheetPath(r.preview)) { ensureDeliverySheet(r.id); continue; }
            // AND THE SHOTS ALREADY ADOPTED, which the gate at adoption time
            // cannot reach. Refusing a duplicate from now on leaves every card
            // that already carries one showing it for ever: measured
            // 2026-09-02, two cards side by side in review with the same empty
            // frame, byte for byte. Retiring hands the card back to its sheet,
            // which at least says what happened; `retirePreview` remembers the
            // path, so the promotion pass does not fish it out again.
            // WHO KEEPS IT: the OLDER shot. Retroactively the two cards are
            // duplicates of EACH OTHER - neither row says who had it first -
            // so a naive check retires whichever the loop reaches first, or
            // both, and blanks two cards to cure one. The file's own mtime is
            // the only witness: the later capture is the copy. Same rule the
            // adoption gate already applies, where the incumbent keeps it.
            const twinCard = isAutoCapturedPreview(r.preview) ? duplicatePreviewOf(r.id, r.preview) : null;
            const mtime = (f: string): number => { try { return statSync(f).mtimeMs; } catch { return 0; } };
            if (twinCard && mtime(r.preview) > mtime(twinCard.path)) {
              try {
                this.retirePreview({
                  taskId: r.id,
                  reason: "Anteprima automatica identica a quella di un'altra card: e' l'app nello stesso stato, non una prova di questa consegna.",
                });
                ensureDeliverySheet(r.id);
              } catch { /* best-effort: the card stays as it was */ }
            }
            continue;
          }
          // Prima si prova l'evidenza VERA (un allegato promuovibile nel
          // thread): la scheda e' l'ultimo ramo, non il primo.
          promoteReviewPreview(r.id);
          const dopo = getTaskRow(r.id);
          if ((dopo?.preview_image ?? "").trim()) coperte++;
        }
        return coperte;
      } catch { return 0; }
    },

recordDelivery({ taskId, branch, commit, stat }): void {
      // A new delivery invalidates any previous verdict: re-audit from scratch
      // rather than leave a stale "landed" on top of fresh, unlanded commits.
      // La TESTIMONIANZA cade con lui: era su un'altra consegna.
      //
      // E CADE ANCHE LA MISURA. Il conteggio di file e lines descrive UNA
      // consegna: lasciarlo su una consegna nuova non misurata farebbe leggere
      // sulla card i numeri del lavoro di prima, che è peggio del non saperlo.
      // Per questo `stat` assente scrive NULL invece di lasciare il valore
      // vecchio: un dato che non si aggiorna insieme al suo soggetto mente.
      // The branch being replaced is still the card's own history: a node round
      // planted `topics/a`, the next round `topics/b` on top of it, and with `a`
      // forgotten the land counted its commits as another session's and landed
      // `b`'s alone (card 76d3e2ff, 17/11: the fix left out, its e2e spec on main).
      db.prepare(
        `UPDATE tasks SET past_delivery_branches = ${REMEMBER_REPLACED_BRANCH}, ` +
        "delivery_branch = ?, delivery_commit = ?, landing_state = NULL, " +
        "landing_checked_at = NULL, landing_witnessed = 0, prior_uncommitted_files = NULL, " +
        "delivery_files_changed = ?, delivery_insertions = ?, delivery_deletions = ? WHERE id = ?",
      ).run(
        branch || null, branch || null, commit || null,
        stat?.filesChanged ?? null, stat?.insertions ?? null, stat?.deletions ?? null,
        taskId,
      );
    },

setDeliveryStat({ taskId, filesChanged, insertions, deletions }): boolean {
      // SOLO I NUMERI, e SOLO se non ci sono. Stessa ragione di
      // `setDeliveryBranch`: l'invariante di `recordDelivery` («un dato che non
      // si aggiorna insieme al suo soggetto mente») serve a impedire che i
      // numeri di una consegna restino su quella dopo. Qui la consegna non
      // cambia — si sta solo misurando quella che c'è già — quindi passare da
      // `recordDelivery` sarebbe distruttivo per due motivi:
      //   · azzera `landing_state`, `landing_checked_at` e `landing_witnessed`,
      //     cioè butta via il verdetto testimoniato a ogni passata di backfill;
      //   · con `stat` non misurabile scrive NULL sopra numeri buoni.
      // La condizione `IS NULL` nella WHERE è la seconda cintura: anche chiamata
      // per sbaglio su una card già misurata, questa non la tocca.
      const r = db.prepare(
        "UPDATE tasks SET delivery_files_changed = ?, delivery_insertions = ?, delivery_deletions = ? " +
        "WHERE id = ? AND delivery_files_changed IS NULL",
      ).run(filesChanged, insertions, deletions, taskId);
      if (r.changes === 0) return false;
      // THE SHEET SHOWS THESE NUMBERS, so whoever writes them redraws it.
      //
      // The sheet is drawn when the card enters review, and these numbers land
      // AFTER: the backfill pass fills them in every half hour, for the paths
      // that reach review without going through the end of a turn. Nobody
      // redrew, so the card kept the old sheet. Measured 2026-09-01 on
      // `dec39cd3`: the sheet read zero files and zero lines both ways — its
      // own words: «file toccati 0, +0 righe aggiunte, -0 righe tolte». allow-italian: the sheet's own labels, quoted.
      // While the column held
      // 4 files and +157 lines. Not an empty box —
      // a box declaring the opposite of the truth, and the only thing that card
      // showed.
      //
      // Safe by construction: `ensureDeliverySheet` writes only over emptiness
      // or over a previous sheet, never over somebody's evidence, and does
      // nothing when the card has left review.
      ensureDeliverySheet(taskId);
      return true;
    },

setDeliveryBranch(taskId: string, branch: string): void {
      // Scrive SOLO delivery_branch, senza toccare commit, diffstat o
      // landing_state. L'invariante di recordDelivery (un dato non aggiornato
      // insieme al suo soggetto mente) non si applica qui: non ci sono nuovi
      // dati da scrivere, solo un indirizzo da conservare prima che la cartella
      // sparisca. Toccare commit/diffstat/landing_state sarebbe distruttivo.
      db.prepare(`UPDATE tasks SET past_delivery_branches = ${REMEMBER_REPLACED_BRANCH}, delivery_branch = ? WHERE id = ?`)
        .run(branch, branch, taskId);
    }
  };
}
