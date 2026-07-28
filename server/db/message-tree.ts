/**
 * Tagliare una conversazione senza buttare via i rami.
 *
 * I messaggi non sono una lista: sono un albero. Ogni volta che si modifica un
 * messaggio o si rigenera una risposta nasce un fratello con lo stesso
 * `parent_id` e un `branch_index` diverso, e `active_branches` ricorda quale
 * ramo si sta guardando. `loadActiveThread` restituisce UN percorso in
 * quell'albero — non tutto l'albero.
 *
 * Da qui il difetto che questo modulo chiude. Il rollback a un checkpoint
 * faceva:
 *
 *     const msgs = loadLocalMessages(sessionKey);   // solo il ramo attivo
 *     saveLocalMessages(sessionKey, msgs.slice(0, n));
 *
 * e `saveLocalMessages` è un RIMPIAZZO totale: `DELETE FROM messages WHERE
 * session_key = ?` più il reinserimento di ciò che gli si passa. Tornare
 * indietro di due messaggi cancellava quindi ogni ramo alternativo della
 * sessione, anche quelli nati MOLTO PRIMA del punto di ripristino e del tutto
 * estranei al taglio. Un lavoro di editing durato ore spariva per un rollback
 * di un turno, senza un avviso e senza modo di recuperarlo.
 *
 * La regola giusta è una sola, e vale sia per l'albero sia per l'intuizione
 * dell'umano: **si cancella ciò che viene DOPO il punto di taglio**. Cioè
 * l'intero sottoalbero appeso all'ultimo messaggio tenuto — tutti i suoi figli,
 * su qualunque ramo, e i loro discendenti. Tutto ciò che sta sopra resta dov'è,
 * fratelli compresi: sono alternative a messaggi che esistono ancora.
 *
 * `saveLocalMessages` resta al suo posto per i chiamanti che vogliono davvero
 * rimpiazzare l'intera sessione (import, reset di una topic). Per TAGLIARE si
 * passa di qui.
 */

import type { Database } from "bun:sqlite";

export interface TruncateResult {
  /** Messaggi rimossi, sottoalbero compreso. */
  deletedMessages: number;
  /** Righe di `active_branches` diventate insensate e rimosse con loro. */
  deletedBranches: number;
  /** Divider di compaction che puntavano a messaggi non più esistenti. */
  deletedMarkers: number;
  /** Quanti messaggi restano nella sessione — rami alternativi INCLUSI. */
  remainingMessages: number;
}

interface Row {
  id: string;
  parent_id: string | null;
}

/**
 * Tutti i discendenti di `fromIds`, in ordine di profondità crescente.
 * L'ordine conta: `messages.parent_id` ha una FK su `messages.id`, quindi si
 * cancella dalle foglie verso l'alto o SQLite rifiuta.
 */
function collectSubtree(rows: Row[], fromIds: string[]): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const r of rows) {
    if (r.parent_id === null) continue; // le radici non sono figlie di nessuno
    const list = childrenOf.get(r.parent_id);
    if (list) list.push(r.id);
    else childrenOf.set(r.parent_id, [r.id]);
  }

  const seen = new Set<string>();
  const frontierInit: string[] = [];
  for (const id of fromIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    frontierInit.push(id);
  }
  let frontier = frontierInit;
  const out: string[] = [...frontier];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const child of childrenOf.get(id) ?? []) {
        if (seen.has(child)) continue; // ciclo: non ci giriamo intorno per sempre
        seen.add(child);
        next.push(child);
      }
    }
    out.push(...next);
    frontier = next;
  }
  return out;
}

/**
 * Taglia la sessione subito dopo `lastKeptId`, cancellando tutto ciò che ne
 * discende su OGNI ramo. `lastKeptId === null` significa "non tenere niente":
 * si parte dalle radici, quindi la sessione resta vuota.
 *
 * Idempotente: rieseguirlo sullo stesso punto non ha altro effetto.
 */
export function truncateSessionAfter(
  db: Database,
  sessionKey: string,
  lastKeptId: string | null,
): TruncateResult {
  return db.transaction(() => {
    const rows = db
      .prepare(`SELECT id, parent_id FROM messages WHERE session_key = ?`)
      .all(sessionKey) as Row[];

    // Da dove parte il taglio: i figli dell'ultimo messaggio tenuto (tutti i
    // rami, non solo quello attivo), oppure le radici se non si tiene nulla.
    const startIds = lastKeptId === null
      ? rows.filter((r) => r.parent_id === null).map((r) => r.id)
      : rows.filter((r) => r.parent_id === lastKeptId).map((r) => r.id);

    const doomed = collectSubtree(rows, startIds);
    if (doomed.length === 0) {
      return {
        deletedMessages: 0,
        deletedBranches: 0,
        deletedMarkers: 0,
        remainingMessages: rows.length,
      };
    }

    const doomedSet = new Set(doomed);
    let deletedMessages = 0;
    const delMsg = db.prepare(`DELETE FROM messages WHERE id = ? AND session_key = ?`);
    // Dalle foglie in su: la FK self-referenziale su parent_id non perdona.
    for (let i = doomed.length - 1; i >= 0; i--) {
      deletedMessages += delMsg.run(doomed[i], sessionKey).changes;
    }

    // `active_branches` è indicizzata sul PADRE. Una riga il cui padre è appena
    // sparito è spazzatura; e anche quella del punto di taglio lo è, perché
    // sotto di lui non c'è più alcun ramo fra cui scegliere.
    let deletedBranches = 0;
    const delBranch = db.prepare(
      `DELETE FROM active_branches WHERE session_key = ? AND parent_id = ?`,
    );
    for (const id of doomed) deletedBranches += delBranch.run(sessionKey, id).changes;
    if (lastKeptId !== null) deletedBranches += delBranch.run(sessionKey, lastKeptId).changes;
    // Chiave '__root__': la usa loadActiveThread per i messaggi senza padre.
    // Ha senso solo finché una radice esiste ancora.
    const rootsLeft = rows.some((r) => r.parent_id === null && !doomedSet.has(r.id));
    if (!rootsLeft) deletedBranches += delBranch.run(sessionKey, "__root__").changes;

    // I divider di compaction sono ancorati a un messaggio (`after_message_id`).
    // Ancorati a un messaggio che non c'è più, resterebbero appesi in cima alla
    // chat a raccontare una compattazione di contenuti spariti.
    let deletedMarkers = 0;
    const delMarker = db.prepare(
      `DELETE FROM compaction_markers WHERE session_key = ? AND after_message_id = ?`,
    );
    for (const id of doomed) deletedMarkers += delMarker.run(sessionKey, id).changes;
    if (!rootsLeft) {
      // Sessione svuotata: anche i divider senza ancora non hanno più a cosa
      // riferirsi.
      deletedMarkers += db
        .prepare(`DELETE FROM compaction_markers WHERE session_key = ?`)
        .run(sessionKey).changes;
    }

    return {
      deletedMessages,
      deletedBranches,
      deletedMarkers,
      remainingMessages: rows.length - deletedMessages,
    };
  })();
}
