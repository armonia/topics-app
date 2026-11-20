import type { Database } from "bun:sqlite";
import { isAbsolute } from "node:path";
import type { ServiceOpts, TaskService } from "../tasks";
import type { createTasksShared } from "./shared";
import { INTERRUPT_CLAIM_MS, TaskServiceError, REOPEN_COMMENT_SLACK_MS } from "./shared";
import { NUDGE_CLAIM_MS, gateNudge } from "../nudge-gate";
import { type TaskComment, hasPlanApproveOption, HUMAN_AUTHOR } from "../../../shared/board";
import { isAgentAuthor } from "../../../shared/comment-author";

export function createCommentsMethods(db: Database, opts: ServiceOpts, shared: ReturnType<typeof createTasksShared>): Pick<TaskService, "recheckRecentDeliveries" | "addComment" | "claimInterruption" | "pendingHumanReopen" | "claimNudge" | "markInterrupted" | "noteStranded"> {
  const {
    DELIVERY_CLAIM_SLOT,
    annotateDeliveryClaims,
    getTaskRow,
    now,
    promoteReviewPreview,
    rowToComment,
    supportsCommentOrigin,
    uuid,
  } = shared;

const commentDedupeMs = opts.commentDedupeMs ?? 10_000;

const interruptClaimMs = opts.interruptClaimMs ?? INTERRUPT_CLAIM_MS;

const nudgeClaimMs = opts.nudgeClaimMs ?? NUDGE_CLAIM_MS;

/**
   * Twin of the probe above, for the column that remembers a NOTE.
   *
   * Both exist because the migration runs when the database is OPENED, and a
   * server already up when the file lands keeps serving the old shape until it
   * reloads. Probing beats assuming: a write that names a column the file has
   * not got yet throws, and it would throw on the ordinary path of every
   * comment.
   */
  let commentQuietColumn: boolean | null = null;

function supportsCommentQuiet(): boolean {
    if (commentQuietColumn === null) {
      const columns = db.prepare("PRAGMA table_info(task_comments)").all() as Array<{ name?: string }>;
      commentQuietColumn = columns.some((column) => column.name === "quiet");
    }
    return commentQuietColumn;
  }

/**
   * Third of the same family, for the row that says WHICH comments a resume
   * envelope carried (`messages.blocks`). The task tables are this service's
   * own; the message rows belong to the chat, and several test benches mount
   * the first without the second. Probing keeps a query that reads the chat
   * from throwing on a bench that never had one.
   */
  let messageBlocksColumn: boolean | null = null;

function supportsMessages(): boolean {
    if (messageBlocksColumn === null) {
      try {
        const messageCols = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name?: string }>;
        // The BRIDGE is probed too, not just the column: the query goes through
        // `topics.session_key`, and half a check leaves standing exactly the
        // case this probe exists to rule out.
        const topicCols = db.prepare("PRAGMA table_info(topics)").all() as Array<{ name?: string }>;
        messageBlocksColumn = messageCols.some((c) => c.name === "blocks")
          && topicCols.some((c) => c.name === "session_key");
      } catch { messageBlocksColumn = false; }
    }
    return messageBlocksColumn;
  }

  return {
recheckRecentDeliveries(sinceIso: string): number {
      const rows = db.prepare(
        `SELECT id, project_id FROM tasks t
          WHERE t.status = 'review' AND t.delivered_by = 'agent' AND t.updated_at >= ?
            AND NOT EXISTS (SELECT 1 FROM task_comments c
                             WHERE c.task_id = t.id AND c.kind = 'review-note' AND c.content LIKE ?)`,
      ).all(sinceIso, `${DELIVERY_CLAIM_SLOT}%`) as Array<{ id: string; project_id: string | null }>;
      for (const r of rows) annotateDeliveryClaims(r.id, r.project_id ?? undefined, (a) => this.addComment(a));
      return rows.length;
    },

addComment({ taskId, author, content, mentions, media, projectId, questionOptions, kind, once, replaces, messageId, origin, quiet }): TaskComment {
      // The kind is whitelisted, never passed through: an unknown value reads
      // as a plain comment, so a typo at a call site costs a visible row rather
      // than a hidden one. 'service' = the dispatcher's own bookkeeping, marked
      // at the source so the thread can fold it without matching on wording.
      const commentKind: "comment" | "review-note" | "service" | "delivery" =
        kind === "review-note" ? "review-note"
          : kind === "service" ? "service"
            : kind === "delivery" ? "delivery"
              : "comment";
      let body = (content ?? "").trim();
      // Attachments-only comments are legal (a screenshot IS the message).
      if (!body && (!media || media.length === 0)) throw new TaskServiceError("invalid_input", "comment content is required");
      if (!body) body = "(allegato)";
      // Absolute paths only (the /api/upload contract); cap the count.
      const files = (media ?? []).filter((p) => typeof p === "string" && isAbsolute(p)).slice(0, 8);
      // Canonical question block, composed HERE (single writer) — the caller
      // passes the question as plain content + structured options; the exact
      // fence/newline layout the quick-reply parser expects is never delegated
      // to an LLM. A question inside `content` that already carries fences
      // would nest ambiguously → reject as invalid input.
      let isPlanDelivery = false;
      if (questionOptions && questionOptions.length > 0) {
        const options = questionOptions.map((o) => String(o ?? "").trim()).filter(Boolean);
        if (options.length === 0) throw new TaskServiceError("invalid_input", "question options are empty");
        if (body.includes("```")) throw new TaskServiceError("invalid_input", "question content must not contain code fences");
        // IL LAYOUT DI QUESTO BLOCCO NON SI TOCCA. Non è formattazione: è il
        // contratto fra l'unico scrittore (qui) e il parser delle risposte
        // rapide del client — cambiarlo significa card senza bottoni, cioè
        // proprio la cosa che deve esserci SEMPRE su un task non chiuso.
        // L'a-capo del corpo resta appiattito perché in questa forma una riga
        // `- …` del corpo sarebbe indistinguibile da un'opzione. Un piano che
        // vuole tenersi l'impaginazione la tiene FUORI dalla fence (il testo
        // attorno al blocco viaggia intatto e viene reso come markdown): il
        // posto dove separare corpo e opzioni è il RENDER, non il salvato.
        body = ["```question", body.replace(/\r?\n/g, " ").trim(), ...options.map((o) => `- ${o}`), "```"].join("\n");
        isPlanDelivery = hasPlanApproveOption(options);
      }
      const row = getTaskRow(taskId);
      // Same projectId guard as update() — no cross-project commenting.
      if (!row || (projectId && row.project_id !== projectId)) {
        throw new TaskServiceError("not_found", `task ${taskId} not found`);
      }

      // Dedupe identical author+content within the window — retries don't double-post.
      // Window boundary derives from the injected clock so tests are deterministic.
      // `once` ⇒ nessuna finestra: la riga descrive una condizione che dura, e
      // riscriverla a ogni verifica e' il muro di paragrafi identici documentato
      // sull'interfaccia.
      const since = once
        ? "0000-01-01T00:00:00.000Z"
        : new Date(new Date(now()).getTime() - commentDedupeMs).toISOString();
      // The slot is emptied BEFORE it is filled, and only for the same author
      // and the same `kind`: a human comment that happens to start with the
      // same words is not the machine's note and must not be touched.
      // MORE THAN ONE OPENING, because the notes of a slot change wording over
      // time. With a single prefix the new note did not recognise the one written
      // by yesterday's code: on a035f945 the old sentence and the new one ended
      // up sitting one under the other, the very duplicate this field exists to
      // remove, reintroduced by the rewording that created the slot. Old openings
      // stay listed for as long as a card still carries one.
      const openings = (Array.isArray(replaces) ? replaces : [replaces])
        .filter((p): p is string => typeof p === "string" && p.trim().length > 0);
      const dupe = db.prepare(
        "SELECT * FROM task_comments WHERE task_id = ? AND author = ? AND content = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1",
      ).get(taskId, author, body, since) as { id: string; created_at: string } | null;
      // A SLOT NOTE THAT IS NO LONGER THE LAST WORD MOVES DOWN. `once` keeps the
      // row already there when nothing was said after it, so a restart does not
      // even move it. But a wait that ended and came back with the same words
      // after a person wrote stayed ABOVE that person's comment, and the thread
      // read as if the machine had spoken first (verifier repro, 24/09/2026).
      // Then the slot is emptied and the note is written again, at the bottom.
      // ANY row by someone else counts, not only a person: an agent, a verifier
      // note, a status transition. A transition after the note means the wait
      // ended and began again, and the new note belongs below it. Only the
      // writer's own notes (same author and kind) do not count: the boot note
      // and the wait note are written one after the other at every boot, and
      // would otherwise push each other down and rewrite both.
      const buried = dupe != null && openings.length > 0 && db.prepare(
        "SELECT 1 FROM task_comments WHERE task_id = ? AND created_at > ? AND NOT (author = ? AND kind = ?) LIMIT 1",
      ).get(taskId, dupe.created_at, author, commentKind) != null;
      if (dupe && !buried) {
        // THE SLOT STILL HOLDS ONE ROW when the text is already there. The
        // dedupe used to return before the slot was emptied, so a pile written
        // before the slot existed survived every later write of the same text:
        // 17 identical wall notes on 89919742 (24/09/2026) would have stayed
        // forever. The surviving row is the one already there, so the thread
        // keeps its place and `updated_at` does not move.
        for (const opening of openings) {
          db.prepare(
            "DELETE FROM task_comments WHERE task_id = ? AND author = ? AND kind = ? AND content LIKE ? AND id != ?",
          ).run(taskId, author, commentKind, `${opening}%`, dupe.id);
        }
        return rowToComment(dupe);
      }

      for (const opening of openings) {
        db.prepare(
          "DELETE FROM task_comments WHERE task_id = ? AND author = ? AND kind = ? AND content LIKE ?",
        ).run(taskId, author, commentKind, `${opening}%`);
      }

      const id = uuid();
      const ts = now();
      const recordedOrigin = origin ?? ((author === "system" || author === "dispatcher" || author === "verifier") ? "system" : null);
      // Optional columns are ASSEMBLED, not branched on: `origin` alone already
      // cost two branches, and `quiet` would have made four - four SQL strings
      // to keep aligned by hand over a one-word difference. A column an older
      // database has not got simply does not join the list.
      const insertColumns = ["id", "task_id", "author", "content", "mentions", "media", "kind", "created_at", "message_id"];
      const values: Array<string | number | null> = [id, taskId, author, body, mentions && mentions.length ? JSON.stringify(mentions) : null, files.length ? JSON.stringify(files) : null, commentKind, ts, messageId ?? null];
      if (supportsCommentOrigin()) { insertColumns.push("origin"); values.push(recordedOrigin); }
      // `quiet: false` and absence are the same thing and both stay NULL: the
      // column says "this row is a note", never "this row is an answer", which
      // is already what every word in the thread is by default.
      if (supportsCommentQuiet() && quiet === true) { insertColumns.push("quiet"); values.push(1); }
      db.prepare(
        `INSERT INTO task_comments (${insertColumns.join(", ")}) VALUES (${insertColumns.map(() => "?").join(", ")})`,
      ).run(...values);
      // The thread is part of the task: touch updated_at so live clients (open
      // drawer, review card) see a change signal and refetch — without this, a
      // new comment broadcasts task:updated but the payload looks identical.
      db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(ts, taskId);
      // QUALE commento è il piano: lo si SCRIVE qui, non lo si indovina dopo.
      // Il segnale è il contratto piano-prima — un task `plan_first` + un blocco
      // question che offre l'approvazione del piano, scritto da un agente (mai
      // dall'umano). Un piano rifatto dopo «Da rivedere» porta le stesse opzioni
      // e quindi RIMPIAZZA il puntatore; una rettifica qualunque, o la consegna
      // con «Landa su main», non lo toccano.
      if (isPlanDelivery && row.plan_first && isAgentAuthor(author)) {
        db.prepare("UPDATE tasks SET plan_comment_id = ? WHERE id = ?").run(id, taskId);
      }
      // Evidence attached AFTER the review transition (review-first delivery
      // order): fill the still-empty card preview from this attachment.
      if (files.length) promoteReviewPreview(taskId);
      return rowToComment(db.prepare("SELECT * FROM task_comments WHERE id = ?").get(id));
    },

claimInterruption({ taskId, note, by, slot }): TaskComment | null {
      const body = (note ?? "").trim();
      if (!body) return null;
      const row = getTaskRow(taskId);
      if (!row) return null;
      // Il campo si legge sul TASK, non su un insieme in memoria: chi arriva
      // terzo è quasi sempre un processo NUOVO — è appena ripartito, ed è il
      // motivo per cui sta scrivendo. La RAM gli direbbe che il campo è libero.
      const since = new Date(new Date(now()).getTime() - interruptClaimMs).toISOString();
      const held = typeof row.interrupt_claimed_at === "string" ? row.interrupt_claimed_at : null;
      if (held && held >= since) return null;
      // La nota PRIMA del campo: se la scrittura fallisce, il campo resta
      // libero per chi viene dopo invece di zittirlo su una riga mai apparsa.
      const written = this.addComment({
        taskId, author: by ?? "system", content: body, kind: "service",
        ...(slot ? { replaces: slot, once: true } : {}),
      });
      db.prepare("UPDATE tasks SET interrupt_claimed_at = ? WHERE id = ?").run(now(), taskId);
      return written;
    },

pendingHumanReopen({ taskId }): { text: string; commentIds: string[] } | null {
      const row = getTaskRow(taskId);
      if (!row) return null;
      if (row.reopened_actor !== "human") return null;
      const at = typeof row.reopened_at === "string" ? Date.parse(row.reopened_at) : NaN;
      if (!Number.isFinite(at)) return null;
      const da = new Date(at - REOPEN_COMMENT_SLACK_MS).toISOString();
      // The same probe the INSERT in `addComment` uses: the migration runs when
      // the database is OPENED, and a server already up serves the old shape
      // until it reloads. Naming a column the file has not got yet throws, and
      // here a throw reads as "no rejection to deliver".
      const notQuiet = supportsCommentQuiet() ? "AND COALESCE(c.quiet, 0) = 0" : "";
      // "Already delivered" is read off the resume envelope, which records the
      // ids of the comments it carried (`dispatched-envelope`). Without the
      // message table - test benches that do not mount one - the question
      // cannot be asked, and the honest answer is "no delivery on record".
      const alreadyDelivered = supportsMessages()
        ? `AND NOT EXISTS (
             SELECT 1 FROM messages m
               JOIN topics tp ON tp.session_key = m.session_key
              WHERE tp.id = ? AND m.blocks LIKE '%' || c.id || '%')`
        : "";
      const args: unknown[] = [taskId, HUMAN_AUTHOR, da];
      if (supportsMessages()) args.push(row.assigned_topic_id ?? "");
      let rows: Array<{ id: string; content: string }> = [];
      try {
        rows = db.prepare(
          `SELECT c.id AS id, c.content AS content
             FROM task_comments c
            WHERE c.task_id = ?
              AND c.author = ?
              AND c.kind = 'comment'
              ${notQuiet}
              AND TRIM(c.content) <> ''
              AND c.created_at >= ?
              ${alreadyDelivered}
            ORDER BY c.created_at, c.rowid`,
        ).all(...(args as [])) as Array<{ id: string; content: string }>;
      } catch { return null; }
      if (rows.length === 0) return null;
      return {
        text: rows.map((r) => r.content.trim()).join("\n\n"),
        commentIds: rows.map((r) => r.id),
      };
    },

claimNudge({ taskId, text }): string {
      const row = getTaskRow(taskId);
      if (!row) return text;
      const verdict = gateNudge({
        text,
        claim: {
          at: typeof row.nudge_claimed_at === "string" ? row.nudge_claimed_at : null,
          fingerprint: typeof row.nudge_fingerprint === "string" ? row.nudge_fingerprint : null,
          repeats: typeof row.nudge_repeats === "number" ? row.nudge_repeats : 0,
        },
        now: now(),
        windowMs: nudgeClaimMs,
        taskId,
      });
      // La scrittura non deve poter zittire il turno: se il campo non si lascia
      // aggiornare, il sollecito parte lo stesso (al massimo si ripete).
      try {
        db.prepare("UPDATE tasks SET nudge_claimed_at = ?, nudge_fingerprint = ?, nudge_repeats = ? WHERE id = ?")
          .run(verdict.claim.at, verdict.claim.fingerprint, verdict.claim.repeats, taskId);
      } catch { /* best-effort: la ripresa vale più del cancello */ }
      return verdict.text;
    },

markInterrupted({ taskIds, by }): number {
      const ids = [...new Set(taskIds)].filter((id) => typeof id === "string" && id.length > 0);
      if (!ids.length) return 0;
      const ts = now();
      let marcate = 0;
      // Riga per riga, ognuna col suo try: siamo dentro uno spegnimento, e una
      // card che non si lascia scrivere non deve portarsi via le altre.
      const stmt = db.prepare(
        "UPDATE tasks SET interrupted_at = ?, interrupted_by = ?, updated_at = ? WHERE id = ? AND status = 'in_progress'",
      );
      for (const id of ids) {
        try { if (stmt.run(ts, by, ts, id).changes > 0) marcate++; }
        catch { /* best-effort: lo spegnimento non fallisce per una nota */ }
      }
      return marcate;
    },

noteStranded({ taskId, note }): TaskComment | null {
      const body = (note ?? "").trim();
      if (!body) return null;
      const row = getTaskRow(taskId);
      if (!row) return null;
      const tagliata = typeof row.interrupted_at === "string" ? row.interrupted_at : null;
      if (!tagliata) return null; // non l'abbiamo tagliata noi: non e' un'orfana
      const detto = typeof row.interrupted_notified_at === "string" ? row.interrupted_notified_at : null;
      if (detto && detto >= tagliata) return null; // gia' raccontata questa interruzione
      // La nota PRIMA del campo, come in `claimInterruption`: se la scrittura
      // fallisce il dedupe resta aperto invece di zittire una riga mai apparsa.
      const written = this.addComment({ taskId, author: "system", content: body, kind: "service" });
      db.prepare("UPDATE tasks SET interrupted_notified_at = ? WHERE id = ?").run(now(), taskId);
      return written;
    }
  };
}
