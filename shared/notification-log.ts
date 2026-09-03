// Il CONTRATTO del registro delle notifiche — condiviso fra client e server
// perché le due porte che ci scrivono stanno una per parte:
//   · il banner nativo lo decide il CLIENT (client/src/hooks/useCompletionNotifier
//     → `fire`, l'unica uscita di ogni segnale in-app);
//   · la web-push la decide il SERVER (server/push-triggers.ts → maybeSendPush).
// Una notifica sola può uscire da entrambe (un `task:review-ready` fa banner E
// push): il registro deve avere UNA riga per evento, e la regola che lo decide
// sta qui, in un modulo puro, invece di essere scritta due volte a memoria.
//
// Il modulo NON tocca il DB e non importa niente: è tipi + decisioni pure, così
// i test lo montano in isolamento e il client può importarlo senza tirarsi
// dietro mezzo server.

/** Il genere dell'evento. Non è un CHECK in SQL — vedi migration 102 sul perché. */
export type NotificationKind =
  | 'task-review'
  | 'task-parked'
  | 'chat-message'
  | 'chat-error'
  | 'session'
  | 'terminal'
  | 'approval'
  | 'other';

export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  'task-review',
  'task-parked',
  'chat-message',
  'chat-error',
  'session',
  'terminal',
  'approval',
  'other',
];

export function isNotificationKind(v: unknown): v is NotificationKind {
  return typeof v === 'string' && (NOTIFICATION_KINDS as readonly string[]).includes(v);
}

/** Dove porta il click. `null` = da nessuna parte (riga leggibile, non cliccabile). */
export type NotificationTargetKind = 'task' | 'topic';

/** Da quale catena è uscita. Serve a leggere il registro quando una notifica
 *  «non è arrivata»: dice se mancava il banner o la push. */
export type NotificationSource = 'banner' | 'push';

/** Quello che una porta consegna al registro. */
export interface NotificationRecordInput {
  kind: NotificationKind;
  title: string;
  body?: string;
  targetKind?: NotificationTargetKind | null;
  targetId?: string | null;
  /** La chiave del dedup: STESSA chiave per lo stesso evento, da qualunque
   *  porta e da qualunque finestra. Vedi `NOTIFICATION_DEDUPE_MS`. */
  dedupeKey: string;
  /** Il raggruppamento, quando la notifica ne collassa più d'uno (il `tag` dei
   *  banner web). Segnare visto un membro segna visto tutto il gruppo. */
  groupKey?: string | null;
  source?: NotificationSource;
}

/** Una riga del registro, come la legge il client. */
export interface NotificationRow {
  id: string;
  createdAt: string;
  kind: NotificationKind;
  title: string;
  body: string;
  targetKind: NotificationTargetKind | null;
  targetId: string | null;
  /** `/task/<id>` o `/topic/<id>` — le stesse rotte dei deep-link. */
  targetUrl: string | null;
  source: NotificationSource;
  groupKey: string | null;
  seenAt: string | null;
}

/**
 * La finestra del dedup: 10 secondi, gli STESSI della cooldown per-chiave che
 * `useCompletionNotifier` applica già ai banner. Non è un numero scelto a caso e
 * non è un UNIQUE: entro la finestra due mittenti dello stesso evento (N
 * finestre, banner + push) diventano una riga sola; fuori dalla finestra la
 * stessa chiave è un evento NUOVO — la seconda review dello stesso task fra un
 * mese deve poter comparire.
 */
export const NOTIFICATION_DEDUPE_MS = 10_000;

/** Il TETTO del registro. Oltre, si tagliano le righe più vecchie. */
export const NOTIFICATION_MAX_ROWS = 500;

/** La SCADENZA. Una notifica di cinque settimane fa non dice più «cosa mi sono
 *  perso»: è archeologia, e sporca la lista che invece serve. */
export const NOTIFICATION_MAX_AGE_DAYS = 30;

/** Quante righe la cronologia mostra in una pagina. */
export const NOTIFICATION_PAGE_SIZE = 50;

/**
 * La destinazione, nel formato che il client sa già aprire: `/task/<id>` e
 * `/topic/<id>` sono le stesse rotte dei deep-link copiabili
 * (client/src/lib/openTaskLink.ts) e delle push (`taskUrl`/`topicUrl` in
 * server/push-triggers.ts). Una terza forma qui vorrebbe dire un terzo parser
 * là, e la cronologia atterrerebbe in un posto diverso dalla notifica che la
 * ha generata — che è precisamente il difetto da non introdurre.
 */
export function notificationTargetUrl(
  kind: NotificationTargetKind | null | undefined,
  id: string | null | undefined,
): string | null {
  if (!kind || !id) return null;
  return kind === 'task' ? `/task/${id}` : `/topic/${id}`;
}

// ── Le chiavi ───────────────────────────────────────────────────────────────
// Scritte QUI perché il dedup funziona solo se le due porte usano la stessa
// stringa per lo stesso evento. Se il client scrivesse `task-review:<id>` e il
// server `task-review-<id>`, ogni consegna lascerebbe due righe e nessuno se ne
// accorgerebbe leggendo il codice di una sola delle due parti.

/** La chat: un messaggio nuovo (banner) e la fine risposta (push) sono lo
 *  STESSO evento per chi lo riceve — «Claude ha risposto in questo topic» —
 *  quindi condividono la chiave e lasciano una riga sola. */
export function chatNotificationKey(topicId: string): string {
  return `chat:${topicId}`;
}

/** A DEAD turn (provider error, retries exhausted, watchdog) is NOT the same
 *  event as a finished reply: it is the one that asks for a gesture (Retry).
 *  Its own key, so it never collapses into the «Claude ha risposto» row. */
export function chatErrorNotificationKey(topicId: string): string {
  return `chat-error:${topicId}`;
}

export function taskReviewNotificationKey(taskId: string): string {
  return `task-review:${taskId}`;
}

export function taskParkedNotificationKey(taskId: string): string {
  return `task-parked:${taskId}`;
}

export function approvalNotificationKey(approvalId: string): string {
  return `approval:${approvalId}`;
}

/**
 * Il raggruppamento di default: il BERSAGLIO. Due notifiche che portano allo
 * stesso task (o allo stesso topic) sono la stessa cosa da guardare, e
 * guardarne una vale per tutte — è il cancello del «visto» che mancava sui
 * rollup e per cui il contatore non tornava a zero.
 *
 * Senza bersaglio non c'è gruppo: una notifica che non porta da nessuna parte
 * risponde solo per sé.
 */
/**
 * A TERMINAL'S GROUP, written once.
 *
 * A terminal is not a target: no route selects a single tab, so
 * `targetKind`/`targetId` stay empty and the default group would be `null`. But
 * the group exists and it is the session, and the row has to be born with this
 * key to be clearable later.
 *
 * The point of the function is that the BIRTH key and the CLEARING key are the
 * same byte: rows are born here (`useCompletionNotifier`) and cleared by
 * `markTargetNotificationsSeen('terminal', id)`, which recomposes `kind:id` on
 * its own. Two hand-written literals drifting by one character would leave the
 * rows lit without breaking anything - which is the original defect.
 */
export const TERMINAL_TARGET_KIND = 'terminal';

export function terminalNotificationGroupKey(sessionId: string): string {
  return `${TERMINAL_TARGET_KIND}:${sessionId}`;
}

export function defaultNotificationGroupKey(
  targetKind: NotificationTargetKind | null | undefined,
  targetId: string | null | undefined,
): string | null {
  if (!targetKind || !targetId) return null;
  return `${targetKind}:${targetId}`;
}

/**
 * Valida quello che arriva dalla rete. Il POST lo fa il client, quindi il
 * server non si fida: un `kind` sconosciuto diventa 'other' (la riga vale
 * comunque, il genere no), un titolo vuoto o una chiave assente sono un
 * rifiuto — una riga senza chiave non può essere deduplicata, e una senza
 * titolo non è leggibile.
 */
export function parseNotificationInput(raw: unknown): NotificationRecordInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  const dedupeKey = typeof o.dedupeKey === 'string' ? o.dedupeKey.trim() : '';
  if (!title || !dedupeKey) return null;
  const targetKind = o.targetKind === 'task' || o.targetKind === 'topic' ? o.targetKind : null;
  const targetId = typeof o.targetId === 'string' && o.targetId ? o.targetId : null;
  return {
    kind: isNotificationKind(o.kind) ? o.kind : 'other',
    // Il registro è una LISTA, non un archivio di testi: i tagli sono gli
    // stessi che il banner applica già al titolo e al corpo.
    title: title.slice(0, 140),
    body: typeof o.body === 'string' ? o.body.slice(0, 400) : '',
    // Un bersaglio a metà (kind senza id, o viceversa) non è un bersaglio.
    targetKind: targetKind && targetId ? targetKind : null,
    targetId: targetKind && targetId ? targetId : null,
    dedupeKey: dedupeKey.slice(0, 200),
    groupKey: typeof o.groupKey === 'string' && o.groupKey ? o.groupKey.slice(0, 200) : null,
    source: o.source === 'push' ? 'push' : 'banner',
  };
}
