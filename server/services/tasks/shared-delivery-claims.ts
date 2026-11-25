/**
 * Delivery-claim annotation of a thread and the reopen/approval settling that reads it.
 */

import type { Database } from "bun:sqlite";
import type { ServiceOpts } from "../tasks";
import { statusEventEnters } from "../../../shared/board";
import { type RepoProbe, checkReport as checkDeliveryReport, gitQuestions } from "../deliveryReportChecks";
import { agentAuthorSql } from "../../../shared/comment-author";
import { probeForRoot, repoProbe } from "../deliveryReportProbe";
import { trackDeliveryNote } from "./shared-constants";
import type { SharedCore } from "./shared-core";


export function createSharedDeliveryClaims(db: Database, opts: ServiceOpts, { getTaskRow, now }: SharedCore) {


/**
   * Quando è iniziato il turno corrente = l'evento `…→in_progress` più recente.
   * Lo leggono `annotateDeliveryClaims` (le rivendicazioni di QUESTO turno) e
   * `hasFreshAgentComment` (la porta di sistema).
   *
   * NON è una `LIKE '%in_progress'`: da quando una transizione può portare la
   * sua ragione (`done→in_progress · il land…`), il contenuto non finisce più
   * con lo stato — e la LIKE avrebbe pescato un turno PRECEDENTE, spostando
   * indietro il confine: rivendicazioni vecchie riaccusate sotto una consegna
   * nuova, e la porta di sistema aperta da una parola di ieri. Le lines di
   * stato di un task sono poche:
   * si leggono e si spacchettano con l'unico parser.
   */
  function lastTurnStart(taskId: string): string | null {
    const rows = db.prepare(
      "SELECT content, created_at FROM task_comments WHERE task_id = ? AND kind = 'status'",
    ).all(taskId) as Array<{ content: string; created_at: string }>;
    let latest: string | null = null;
    for (const r of rows) {
      if (!statusEventEnters(r.content, "in_progress")) continue;
      if (latest === null || r.created_at > latest) latest = r.created_at;
    }
    return latest;
  }


/**
   * Il predicato del gate `review_needs_summary`, estratto per essere chiamato
   * anche dalle porte di sistema (`deliverToReviewBySystem`, `askParkedChildren`)
   * che non passano da `update()`.
   *
   * Dentro `update()` il predicato BLOCCA (l'agente può riprovare). Dalle porte
   * di sistema NON blocca — il turno e' gia' finito, la card deve andare da
   * qualche parte — ma il fatto si ANNOTA: chi rivede sa subito che l'agente non
   * ha dichiarato nulla, e non deve scoprirlo aprendo il worktree.
   *
   * `true` = il turno ha prodotto almeno un commento dell'agente = consegna non
   * muta. `false` = nessuna parola fresca = annotare.
   */
  /**
   * ANNOTATES a delivery with whichever of its claims do not hold up.
   *
   * IT DOES NOT BLOCK, and that is a choice rather than a lack of nerve. An
   * audit of `done` tasks found 14 cards closed with no work behind them, and
   * the four mechanical checks (`deliveryReportChecks.ts`) catch them. But the
   * check can be wrong: in its first hour of life it accused 20 paths that all
   * existed, because reports cite files by short name. A gate that blocks an
   * honest delivery gets switched off, and then it is not there for the
   * dishonest one either.
   *
   * So: it writes a review note the human reads before approving. `replaces`
   * keeps it in ONE slot rather than a pile, because this runs on every
   * transition into review.
   *
   * Best-effort throughout: any error here is swallowed. A missing note must
   * never stop a finished turn from delivering.
   */
  function annotateDeliveryClaims(
    taskId: string,
    projectId: string | undefined,
    /** The service's `addComment`: passed in rather than reached, because this
     *  function lives outside the object that exposes it. */
    emit: (a: { taskId: string; author: string; content: string; kind: "review-note"; projectId?: string; replaces?: string }) => unknown,
  ): void {
    try {
      // THE SLOT IS EMPTIED HERE, not by the note that fills it.
      //
      // `replaces` only deletes when something new gets written, so a card
      // annotated in turn 1 and delivered clean in turn 2 kept the turn-1
      // accusation on it: the reviewer read a "commit 0000000deadbee1 does not
      // exist" note under a delivery that mentioned no commit at all. Each
      // delivery answers for itself — the previous one's note goes away with
      // the previous one.
      db.prepare(
        "DELETE FROM task_comments WHERE task_id = ? AND kind = 'review-note' AND content LIKE ?",
      ).run(taskId, `${DELIVERY_CLAIM_SLOT}%`);
      // And a note still on its way for the previous delivery must not land
      // after this: see `late` below.
      const generation = (deliveryGeneration.get(taskId) ?? 0) + 1;
      deliveryGeneration.set(taskId, generation);

      const turnStart = lastTurnStart(taskId);
      // 'delivery' belongs here, and is in fact the FIRST thing to check: it is
      // the declared report, the one the reviewer reads. Leaving it out would
      // have made this check blind to exactly the sentence it exists for.
      const rows = db.prepare(
        `SELECT content FROM task_comments
          WHERE task_id = ? AND ${agentAuthorSql()}
            AND COALESCE(kind, 'comment') IN ('comment', 'delivery')
            AND (? IS NULL OR created_at >= ?)
          ORDER BY created_at DESC LIMIT 3`,
      ).all(taskId, turnStart, turnStart) as Array<{ content: string }>;
      if (rows.length === 0) return;

      let probe: RepoProbe = repoProbe;
      let knownRoots: string[] = [];
      try {
        const row = getTaskRow(taskId);
        const root = opts.repoRootFor?.({ taskId, projectId, assignedTopicId: (row?.assigned_topic_id as string | null) ?? null }) ?? null;
        if (root) probe = (opts.probeFor ?? probeForRoot)(root);
        try { knownRoots = opts.listRepoRoots?.() ?? []; } catch { /* best-effort */ }
        if (knownRoots.length === 0) {
          try { knownRoots = opts.listProjectDirs?.() ?? []; } catch { /* best-effort */ }
        }
        if (root) knownRoots.unshift(root);
      } catch { /* the server's own checkout, as before */ }
      const reports = rows.map((r) => r.content ?? "");
      /** True when a note was written. */
      const writeNote = (answers: RepoProbe): boolean => {
        const findings = reports.flatMap((r) => checkDeliveryReport(r, answers));
        // "Nothing to check" is not a finding worth showing: that is a report
        // written in prose, which is legitimate. Only what was LOOKED UP and not
        // found gets annotated.
        const real = findings.filter((f) => f.code !== "nothing-to-check");
        if (real.length === 0) return false;

        const lines = [...new Set(real.map((f) => `- ${f.detail}`))].slice(0, 8);
        emit({
          taskId,
          author: "verifier",
          kind: "review-note",
          ...(projectId ? { projectId } : {}),
          replaces: DELIVERY_CLAIM_SLOT,
          content:
            `${DELIVERY_CLAIM_SLOT} ${lines.length} rivendicazione/i del rapporto non si verificano:\n` +
            lines.join("\n") +
            "\n\nNon blocca l'approvazione: e' un controllo meccanico e puo' sbagliare. " +
            "Ma ognuna di queste si controlla in due secondi, ed e' esattamente cio' che nessuno " +
            "faceva sulle 14 carte chiuse senza lavoro.",
        });
        return true;
      };
      // Git is never asked inside this update (`git log -S` took up to 20 s
      // here, with the whole server standing still): the probe asks off the
      // loop, and the note follows its answers. A report that asks git nothing
      // is written now, and so is anything checked by a probe that answers
      // inline, as the injected ones in the tests do.
      const asksGit = reports.some((r) => {
        const q = gitQuestions(r);
        return q.shas.length > 0 || q.citesFiles || q.symbols.length > 0;
      });
      if (!probe.prepare || !asksGit) { writeNote(probe); return; }
      const late = (answers: RepoProbe): void => {
        // THE NOTE ANSWERS FOR ITS OWN DELIVERY. If the card was delivered
        // again meanwhile, that delivery emptied the slot and this report is
        // no longer the one under review: written now, an old accusation
        // would sit under a clean delivery (PR #147, second review).
        if (deliveryGeneration.get(taskId) !== generation) return;
        try {
          if (writeNote(answers)) opts.onLateDeliveryNote?.(taskId, projectId);
        } catch { /* as below */ }
      };
      trackDeliveryNote(probe.prepare(reports, { knownRoots }).then(late, () => {}));
    } catch {
      // See the docblock: a missing note is not a delivery failure.
    }
  }


/** Slot prefix: `replaces` uses it to empty before filling. */
  const DELIVERY_CLAIM_SLOT = "[consegna]";


/** Per card, how many times it has been annotated: a late note checks it is
   *  still the latest before writing. */
  const deliveryGeneration = new Map<string, number>();


function hasFreshAgentComment(taskId: string): boolean {
    const turnStart = lastTurnStart(taskId);
    const c = (db.prepare(
      `SELECT COUNT(*) AS c FROM task_comments
        WHERE task_id = ? AND ${agentAuthorSql()} AND kind IN ('comment', 'delivery')
          AND (? IS NULL OR created_at >= ?)`,
    ).get(taskId, turnStart, turnStart) as any).c as number;
    return c > 0;
  }


/**
   * Segna che una card è USCITA da `done` o da `review`, per le porte che
   * scrivono lo status a SQL grezzo (release, deferForWait,
   * deliverToReviewBySystem, il rifiuto in review). `update()` scrive le stesse
   * colonne dentro la sua unica UPDATE — qui non passa.
   *
   * Le due partenze valgono uguale: chi tira una card fuori dalla consegna sta
   * chiedendo un SEGUITO, e il segno non può dipendere da quale colonna ha
   * attraversato. No-op su tutto il resto, sull'arrivo in `done` (lì il ciclo si
   * chiude e il segno cade, non si accende) e sulla transizione che non muove
   * niente — una consegna forzata su una card GIÀ in review non è un'uscita.
   */
  function markReopened(taskId: string, from: string, to: string, actor: "human" | "agent" | "system", by: string): void {
    if (from !== "done" && from !== "review") return;
    if (to === "done" || to === from) return;
    try {
      // `done_actor` si spegne solo uscendo da `done`: una card in review non ne
      // ha uno, e cancellarlo da qui riscriverebbe una decisione che questo
      // salto non tocca.
      const spegniDone = from === "done" ? "done_actor = NULL, " : "";
      // Il marchio dell'umano non lo cancella la macchina passandoci sopra: una
      // card già segnata «riaperta da Attilio» può riconsegnare e poi rientrare
      // in coda da una porta di sistema, e riscriverla `system` spegnerebbe il
      // cancello che protegge la sua richiesta.
      const nonScavalcare = actor === "human" ? "" : " AND (reopened_actor IS NULL OR reopened_actor <> 'human')";
      db.prepare(
        `UPDATE tasks SET ${spegniDone}reopened_at = ?, reopened_by = ?, reopened_actor = ? WHERE id = ?${nonScavalcare}`,
      ).run(now(), by || "system", actor, taskId);
    } catch { /* la traccia è best-effort — non fa fallire la transizione */ }
  }


/**
   * LA RICHIESTA DI APPROVAZIONE SI CHIUDE CON LA CARD, da qualunque porta esca.
   *
   * Era scritta a mano in due punti e mancava negli altri due. Misurate il 13/08:
   * 13 lines `pending` su 48 appese, 9 delle quali su card già `done` — la
   * migration 068 aveva già dovuto ripulire esattamente questa perdita. Landare e
   * archiviare sono le due strade che restavano scoperte: la prima chiude la card
   * a SQL grezzo (`settleLanded`), la seconda la toglie dalla board senza passare
   * da `update`.
   *
   * L'ESITO non è sempre lo stesso, ed è la parte che non si può accorpare:
   * arrivare a `done` è ciò che l'approvazione chiedeva, quindi `approved`; ogni
   * altra destinazione la rende priva di oggetto — `expired`, non `rejected`,
   * perché nessuno ha detto di no. Il `rejected` lo scrive solo chi ha davvero
   * ricevuto un no da una persona.
   *
   * Best-effort: la riga è contabilità, e non deve poter far fallire la
   * transizione che la chiude.
   */
  function settleReviewApproval(
    taskId: string,
    outcome: "approved" | "rejected" | "expired",
    by: string,
    ts: string,
    comment?: string | null,
  ): void {
    try {
      db.query(
        `UPDATE approvals SET status = ?, reviewed_by = ?,
            review_comment = COALESCE(?, review_comment), reviewed_at = ?
          WHERE task_id = ? AND approval_type = 'review' AND status = 'pending'`,
      ).run(outcome, by, comment ?? null, ts, taskId);
    } catch { /* contabilità: non fa fallire la transizione */ }
  }
  return {
    DELIVERY_CLAIM_SLOT,
    annotateDeliveryClaims,
    deliveryGeneration,
    hasFreshAgentComment,
    lastTurnStart,
    markReopened,
    settleReviewApproval,
  };
}
