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
