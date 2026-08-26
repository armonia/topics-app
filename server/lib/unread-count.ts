/**
 * L'incremento del non-letto di una topic, con la politica di lettura che lo
 * governa — una sola, scritta in un posto solo.
 *
 * Viveva dentro la closure di `createTopicsRouter`, da dove veniva iniettata in
 * due router (`edit`, `chat`) e usata dal watcher dei sub-agent: un helper con
 * tre consumatori, chiuso in uno scope che nessun test poteva aprire. Qui è una
 * funzione con le sue dipendenze esplicite, e la politica ha finalmente dei
 * test che la fissano.
 *
 * ── La politica ─────────────────────────────────────────────────────────────
 * Un messaggio in arrivo incrementa SEMPRE il non-letto; solo un `read`
 * esplicito (POST /api/topics/:id/read, che il client manda dopo SEEN_DWELL_MS
 * di sguardo continuo) lo azzera.
 *
 * Prima c'era un gate `if (!isTopicFocused(topicId))` — «presente = letto»,
 * senza nozione di tempo. Era rotto in due modi: (1) un messaggio ad app in
 * background non produceva MAI il badge, perché il server considerava ancora
 * focussata l'ultima chat vista (nessun blur affidabile lato client, focus
 * ri-annunciato a ogni riconnessione); (2) la soppressione era GLOBALE —
 * bastava una qualsiasi socket (altro device, altra finestra, PWA dimenticata)
 * con quella topic focussata perché NESSUNO ricevesse il badge. Da quando il
 * client marca letto sulla soglia, quel gate era ridondante E dannoso.
 */
import type { UnreadData } from "../../shared/types";
import type { OutboundMessage } from "../../shared/ws-outbound";

export interface UnreadDeps {
  loadUnread: () => UnreadData;
  saveUnread: (data: UnreadData) => void;
  broadcastToAll: (message: OutboundMessage) => void;
  /**
   * Whether this topic is archived. REQUIRED, and deliberately not optional:
   * an optional predicate defaults to "no" at every call site that forgets it,
   * which is the same silence this guard exists to end.
   */
  isArchived: (topicId: string) => boolean;
}

/**
 * Incrementa di uno il non-letto di `topicId` e lo annuncia ai client.
 *
 * Best-effort per costruzione: un errore di persistenza non deve far fallire la
 * consegna del messaggio che l'ha provocato — il badge è un'informazione
 * accessoria, il messaggio no. Per questo l'eccezione si registra e si assorbe.
 */
export function bumpUnreadCount(deps: UnreadDeps, topicId: string): void {
  try {
    // AN ARCHIVED TOPIC DOES NOT GROW A BADGE.
    //
    // Archiving already resets the counter (`archiveTopicFully`, and all three
    // archive paths go through it), so the invariant looked closed. It was
    // closed on the ARCHIVING edge only: nothing stopped a message arriving
    // AFTERWARDS from raising the badge again on a topic nobody will open.
    //
    // Measured on 2026-08-26, three weeks after that fix landed:
    //
    //   select count(*) from unread u join topics t on t.id = u.topic_id
    //   where u.unread_count > 0 and t.archived = 1;   -> 475
    //
    // with rows whose `last_read_at` runs to 23/08. A counter repaired only
    // where it is written and never where it is incremented is repaired on the
    // wrong edge.
    if (deps.isArchived(topicId)) return;

    const unread = deps.loadUnread();
    if (!unread[topicId]) unread[topicId] = { lastReadAt: new Date().toISOString(), unreadCount: 0 };
    unread[topicId].unreadCount += 1;
    deps.saveUnread(unread);
    deps.broadcastToAll({
      type: "unread:updated",
      topicId,
      unreadCount: unread[topicId].unreadCount,
    } as OutboundMessage);
  } catch (err) {
    console.warn(`[topics] updateUnreadCount failed for ${topicId}:`, err);
  }
}
