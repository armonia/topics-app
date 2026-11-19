/** Message branching: siblings, branch rows, subtree deletes and empty-turn discards. */
import type { Database } from "bun:sqlite";
import { isEmptyAssistantTurn } from "../../shared/empty-turn";
import { decodeCol } from "../../shared/message-blob";
import type { StoredMessage } from "../types";
import type { AppStatements, DbRow } from "./app-statements";
import type { MessageThreadReads } from "./message-thread-reads";

export function createMessageBranches({ db, stmts, rowToMessage, metaParams }: { db: Database; stmts: AppStatements; rowToMessage: MessageThreadReads["rowToMessage"]; metaParams: MessageThreadReads["metaParams"] }) {
  // --- Branching helpers ---
  function getMessageById(id: string): StoredMessage | null {
    const row = stmts.getMessageById.get(id) as DbRow;
    return row ? rowToMessage(row) : null;
  }

  function getMessageSessionKey(id: string): string | null {
    const row = stmts.getMessageById.get(id) as DbRow;
    return row?.session_key || null;
  }

  function createBranchMessage(
    sessionKey: string,
    parentId: string,
    role: "user" | "assistant",
    content: string,
    /** Chi l'ha scritto (095). Un prompt CORRETTO è un prompt: senza questo, chi
     *  riscrive una domanda invece di ribatterla sparisce dai conteggi. */
    autore?: { authorPersonId?: string | null; authorDeviceId?: string | null },
  ): StoredMessage {
    const maxOrder = (stmts.getMaxSortOrder.get(sessionKey) as { max_order: number }).max_order;
    const maxBranch = (stmts.getMaxBranchIndex.get(parentId) as { max_idx: number }).max_idx;
    const branchIndex = maxBranch + 1;
    const stored: StoredMessage = {
      id: crypto.randomUUID(), role, content, timestamp: new Date().toISOString(), parentId, branchIndex,
      authorPersonId: autore?.authorPersonId ?? null,
      authorDeviceId: autore?.authorDeviceId ?? null,
    };
    stmts.insertMessage.run({
      $id: stored.id,
      $session_key: sessionKey,
      $role: role,
      $content: content,
      $thinking: null,
      $tool_calls: null,
      $media: null,
      $partial: 0,
      $streamed_at: null,
      $plan_status: null,
      $timestamp: stored.timestamp,
      $sort_order: maxOrder + 1,
      $parent_id: parentId,
      $branch_index: branchIndex,
      ...metaParams(stored),
    });
    // Set this new branch as active
    stmts.upsertActiveBranch.run(parentId, sessionKey, branchIndex);
    return stored;
  }

  function createBranchPartialMessage(sessionKey: string, parentId: string): StoredMessage {
    const maxOrder = (stmts.getMaxSortOrder.get(sessionKey) as { max_order: number }).max_order;
    // Allocate the next branch index under the parent, like createBranchMessage.
    // This used to hardcode 0 — correct on the EDIT path (the parent is a
    // brand-new user message with no children) but colliding on REGENERATE,
    // where the anchor user message already has the original assistant reply
    // at index 0: two children with the same branch_index break both
    // loadActiveThread's selection and the sibling arrows.
    const maxBranch = (stmts.getMaxBranchIndex.get(parentId) as { max_idx: number }).max_idx;
    const branchIndex = maxBranch + 1;
    const stored: StoredMessage = {
      id: crypto.randomUUID(), role: "assistant", content: "", timestamp: new Date().toISOString(),
      partial: true, streamedAt: new Date().toISOString(), parentId, branchIndex,
    };
    stmts.insertMessage.run({
      $id: stored.id,
      $session_key: sessionKey,
      $role: "assistant",
      $content: '',
      $thinking: null,
      $tool_calls: null,
      $media: null,
      $partial: 1,
      $streamed_at: stored.streamedAt!,
      $plan_status: null,
      $timestamp: stored.timestamp,
      $sort_order: maxOrder + 1,
      $parent_id: parentId,
      $branch_index: branchIndex,
      ...metaParams({}),
    });
    // The fresh branch is what the user asked for — make it the active one
    // (no-op semantics when it's the parent's only child, index 0).
    stmts.upsertActiveBranch.run(parentId, sessionKey, branchIndex);
    return stored;
  }

  /**
   * Cancella un messaggio E tutto il sottoalbero che gli pende sotto, riparando
   * la contabilità dei rami:
   *  · i fratelli superstiti vengono rinumerati DENSI (le frecce fanno ±1 sul
   *    valore letterale di `branch_index`: un buco le lascerebbe a vuoto);
   *  · il puntatore attivo del padre atterra su un fratello vivo, o sparisce
   *    quando restano 0/1 figli (indice 0 per default);
   *  · le righe di `active_branches` che puntano a un id cancellato se ne vanno.
   *
   * Stava inline dentro `DELETE /api/messages/:id`. Ora lo chiama anche lo
   * scarto del segnaposto vuoto sull'abort: due copie della stessa transazione
   * vorrebbero dire due modi diversi di riparare i rami, e uno dei due sbagliato.
   * Ritorna `false` se il messaggio non esiste.
   */
  function deleteMessageSubtree(sessionKey: string, messageId: string): boolean {
    const msg = getMessageById(messageId);
    if (!msg) return false;
    const deletedIndex = msg.branchIndex ?? 0;
    const parentKey = msg.parentId ?? "__root__";
    db.transaction(() => {
      // Ids del sottoalbero (se stesso incluso) via CTE ricorsiva, per sessione.
      const subtree = db
        .prepare(
          `WITH RECURSIVE sub(id) AS (
             SELECT id FROM messages WHERE id = ? AND session_key = ?
             UNION ALL
             SELECT m.id FROM messages m JOIN sub ON m.parent_id = sub.id
           ) SELECT id FROM sub`,
        )
        .all(messageId, sessionKey) as Array<{ id: string }>;
      const ids = subtree.map(r => r.id);
      const placeholders = ids.map(() => "?").join(",");
      db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...ids);
      db.prepare(`DELETE FROM active_branches WHERE session_key = ? AND parent_id IN (${placeholders})`)
        .run(sessionKey, ...ids);

      // Riferimenti che restavano appesi nel vuoto: nessuna di queste tabelle ha
      // una FK verso `messages`, quindi cancellare un sottoalbero lasciava pin e
      // menzioni che puntavano a righe inesistenti (due se ne contavano nel DB
      // vivo il 30/07). Il marcatore di compattazione invece non si butta: dice
      // "la compattazione sta DOPO questo messaggio", e ereditando il padre del
      // sottoalbero resta nello stesso punto del thread (`NULL` = in testa).
      db.prepare(`DELETE FROM topic_pinned_messages WHERE message_id IN (${placeholders})`).run(...ids);
      db.prepare(`DELETE FROM mentions WHERE message_id IN (${placeholders})`).run(...ids);
      db.prepare(
        `UPDATE compaction_markers SET after_message_id = ? WHERE after_message_id IN (${placeholders})`,
      ).run(msg.parentId ?? null, ...ids);

      // Rinumera densi i fratelli superstiti, conservandone l'ordine.
      const siblings = db
        .prepare(
          msg.parentId
            ? `SELECT id, branch_index FROM messages WHERE session_key = ? AND parent_id = ? ORDER BY branch_index ASC`
            : `SELECT id, branch_index FROM messages WHERE session_key = ? AND parent_id IS NULL ORDER BY branch_index ASC`,
        )
        .all(...(msg.parentId ? [sessionKey, msg.parentId] : [sessionKey])) as Array<{ id: string; branch_index: number }>;
      const renumber = db.prepare(`UPDATE messages SET branch_index = ? WHERE id = ?`);
      siblings.forEach((s, i) => { if (s.branch_index !== i) renumber.run(i, s.id); });

      if (siblings.length <= 1) {
        db.prepare(`DELETE FROM active_branches WHERE session_key = ? AND parent_id = ?`).run(sessionKey, parentKey);
      } else {
        // Atterra sul fratello che ha preso il posto del ramo cancellato (o
        // sull'ultimo, quando il cancellato era l'indice più alto).
        const nextActive = Math.min(deletedIndex, siblings.length - 1);
        db.prepare(`INSERT OR REPLACE INTO active_branches (parent_id, session_key, active_branch_index) VALUES (?, ?, ?)`)
          .run(parentKey, sessionKey, nextActive);
      }
    })();
    return true;
  }

  /**
   * "Un turno che non ha prodotto niente non lascia niente."
   *
   * Da chiamare DOPO aver finalizzato un turno interrotto: se la riga
   * dell'assistente è rimasta completamente vuota (niente testo, niente
   * ragionamento, nessuna tool call, nessun blocco, nessun media) il segnaposto
   * viene cancellato invece di restare in chat. Al modello non arrivava comunque
   * (la history verso il provider scarta i turni vuoti, `empty-after-strip` in
   * server/context/assemble.ts): il danno era nel thread salvato e in pagina.
   * Ritorna l'id scartato, o `null` se il turno aveva prodotto qualcosa (allora
   * si tiene: è lavoro fatto).
   */
  function discardIfEmptyTurn(sessionKey: string, msg: StoredMessage | null): string | null {
    if (!msg || !isEmptyAssistantTurn(msg)) return null;
    // Il predicato ha detto «vuoto» su ciò che il chiamante gli ha messo in mano,
    // e chi arriva da `updateLastMessage` legge magro: `blocks` e `tool_calls`
    // NON sono su `msg`, quindi «assenti» qui vuol dire «non li ho guardati»,
    // non «non ci sono». Prima di cancellare una riga si guardano — è una
    // domanda booleana, e la risponde SQLite senza portare qui le due colonne
    // più pesanti della tabella. Senza questo controllo un turno fatto di soli
    // tool, o di soli blocchi, verrebbe scartato come segnaposto vuoto: lavoro
    // fatto, cancellato in silenzio.
    const presence = stmts.messageBodyPresence.get(msg.id) as
      { has_tool_calls?: number; has_blocks?: number } | undefined;
    if (presence?.has_tool_calls) return null;
    // I BLOCCHI non bastano a salvare una riga, se sono solo l'eco del testo.
    //
    // La sonda SQL risponde «ci sono blocchi», e per un turno di soli tool è la
    // risposta giusta — quello è lavoro. Ma il testo diventa anch'esso un
    // blocco, quindi una riga il cui unico contenuto è una SENTINELLA della CLI
    // («No response requested.») arriverebbe qui con un blocco `text` e si
    // salverebbe, mentre il predicato l'ha appena dichiarata vuota: due letture
    // della stessa riga che si contraddicono.
    //
    // Il giudizio su COSA c'è dentro sta in un posto solo — `isEmptyAssistantTurn`
    // in shared/empty-turn.ts — quindi qui si va a prendere la colonna e gliela
    // si dà. Costa una lettura mirata, e solo su una riga già dichiarata vuota.
    if (presence?.has_blocks) {
      const row = stmts.getMessageBlocks.get(msg.id) as { blocks?: unknown } | undefined;
      // Through `decodeCol`, like every other reader of this column: the writer
      // stores it as zstd above 512 bytes, and the predicate wants the JSON.
      if (!isEmptyAssistantTurn({ role: "assistant", blocks: decodeCol(row?.blocks) })) return null;
    }
    // An empty placeholder with rows under it stays. The turn is finalized by
    // id, so this can be a row that others were born after, and those hang
    // from it (`appendLocalMessage` parents to the last row): the user's
    // resend, a sub-agent's exit report. The delete below takes a SUBTREE, and
    // an empty bubble costs less than a lost message.
    if (stmts.messageHasChildren.get(sessionKey, msg.id)) return null;
    return deleteMessageSubtree(sessionKey, msg.id) ? msg.id : null;
  }

  function switchActiveBranch(sessionKey: string, parentId: string, branchIndex: number): void {
    stmts.upsertActiveBranch.run(parentId, sessionKey, branchIndex);
  }

  function getSiblingMessages(parentId: string): StoredMessage[] {
    const rows = stmts.getSiblings.all(parentId) as DbRow[];
    return rows.map((row) => rowToMessage(row));
  }

  return { getMessageById, getMessageSessionKey, createBranchMessage, createBranchPartialMessage, deleteMessageSubtree, discardIfEmptyTurn, switchActiveBranch, getSiblingMessages };
}

