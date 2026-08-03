/**
 * Archiviare un topic, per intero, in un posto solo.
 *
 * PERCHÉ ESISTE. Archiviare si faceva in tre punti e solo due facevano le
 * pulizie. Il terzo — `archiveTopic` in server.ts, quello che il dispatcher usa
 * per potare i topic dei tentativi a fine task, quindi quello che gira di più —
 * alzava il flag `archived`, salvava e broadcastava. Punto: niente reset
 * dell'unread, niente purge da `ui_state`. Il conto, misurato il 03/08: 427
 * messaggi non letti appesi a 170 topic archiviati (badge su conversazioni che
 * l'interfaccia non mostra più, e che nessun gesto umano può azzerare — l'unread
 * si resetta APRENDO il topic, ma il topic è archiviato), più il ghost-topic:
 * senza purge il record `ui_state` resta stale e l'id del topic archiviato
 * risuscita al reload successivo.
 *
 * COSA GARANTISCE. Dopo questa funzione, per quel topic valgono tutte e tre:
 *   1. `archived = true`, salvato e broadcastato,
 *   2. unread azzerato e broadcastato,
 *   3. nessun riferimento al topic nei record `ui_state` (tombstonato).
 * È lo stato finale che il percorso umano (`DELETE /api/topics/:id`) produceva
 * già; qui smette di essere una proprietà di QUEL percorso e diventa la
 * definizione di "archiviato".
 *
 * PERCHÉ LA PURGE È INIETTATA. `purgeTopicFromUiState` vive con le rotte, e un
 * servizio che importa da `routes/` inverte gli strati. Il chiamante la passa;
 * il servizio dichiara solo di averne bisogno.
 *
 * CONVERGENTE, non solo idempotente. Su un topic GIÀ archiviato non riscrive il
 * flag né ribroadcasta (`alreadyArchived`), ma i passi 2 e 3 li fa lo stesso.
 * La differenza non è teorica: la bonifica del 03/08 — i 170 topic ripassati
 * per spegnere 427 badge — ha funzionato proprio perché ri-archiviare qualcosa
 * di già archiviato RIPARAVA. Uscire subito la renderebbe un no-op, e l'unico
 * modo di rimediare a uno stato sporco tornerebbe a essere una query a mano.
 */
import type { Topic, UnreadData } from "../../shared/types";
import type { OutboundMessage } from "../../shared/ws-outbound";

export interface ArchiveTopicDeps {
  getTopicById: (id: string) => Topic | null;
  saveSingleTopic: (topic: Topic) => void;
  loadUnread: () => UnreadData;
  saveUnread: (data: UnreadData) => void;
  broadcastToAll: (message: OutboundMessage) => void;
  /** `purgeTopicFromUiState` (routes/topics.ts), passata dal chiamante. */
  purgeFromUiState: (topicId: string) => { ok: true } | { ok: false; error: string };
}

export interface ArchiveTopicResult {
  /** Il topic esisteva ed è stato archiviato adesso (o lo era già). */
  ok: boolean;
  /** Nessun topic con quell'id: niente da fare, nessun errore. */
  notFound?: boolean;
  /** Era già archiviato: il flag non è stato riscritto né ribroadcastato — ma
   *  unread e ui_state sono stati riportati allo stato giusto comunque. */
  alreadyArchived?: boolean;
  /** Qualcosa era fuori posto ed è stato riparato (unread non a zero su un
   *  topic già archiviato): è il sintomo che qualche percorso ha archiviato
   *  saltando le pulizie. */
  repaired?: boolean;
  /**
   * L'archiviazione è avvenuta ma la purge di `ui_state` è fallita: il topic è
   * archiviato e il registro che l'interfaccia legge è stale, quindi quell'id
   * può ripresentarsi al reload. Chi ha una risposta HTTP da restituire deve
   * trasformarlo in un 500 — è esattamente il caso che non va perso in silenzio.
   */
  purgeError?: string;
  /** Il topic dopo la scrittura (per la risposta del chiamante). */
  topic?: Topic;
}

export function archiveTopicFully(deps: ArchiveTopicDeps, topicId: string): ArchiveTopicResult {
  const topic = deps.getTopicById(topicId);
  if (!topic) return { ok: false, notFound: true };
  const alreadyArchived = topic.archived;

  const now = new Date().toISOString();

  // 1. Il flag. Solo se serve: ri-archiviare qualcosa di già archiviato non
  // deve sporcare `updatedAt` né far lampeggiare le liste dei client.
  if (!alreadyArchived) {
    topic.archived = true;
    topic.updatedAt = now;
    deps.saveSingleTopic(topic);
    deps.broadcastToAll({ type: "topic:archived", topic });
  }

  // 2. Unread a zero. Va fatto QUI e non "quando l'utente aprirà il topic":
  // archiviato, quel topic non è più apribile, quindi il badge resterebbe
  // appeso per sempre.
  //
  // Sull'archiviazione fresca si scrive sempre (anche `lastReadAt`, come faceva
  // il percorso umano). Su un topic GIÀ archiviato si scrive solo se c'è
  // davvero un badge da spegnere: è il caso bonifica, e il ripasso di 170 topic
  // non deve costare 170 scritture e 170 broadcast per niente.
  const unread = deps.loadUnread();
  const stale = (unread[topicId]?.unreadCount ?? 0) > 0;
  if (!alreadyArchived || stale) {
    unread[topicId] = { lastReadAt: now, unreadCount: 0 };
    deps.saveUnread(unread);
    deps.broadcastToAll({ type: "unread:updated", topicId, unreadCount: 0 });
  }

  // 3. Via da ui_state, o l'id risuscita al prossimo reload del client.
  const purge = deps.purgeFromUiState(topicId);

  const repaired = alreadyArchived && stale;
  if (!purge.ok) return { ok: true, alreadyArchived, repaired, purgeError: purge.error, topic };

  return { ok: true, alreadyArchived, repaired, topic };
}
