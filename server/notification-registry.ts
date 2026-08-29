/**
 * La PORTA UNICA del registro delle notifiche, lato server.
 *
 * Sotto c'è `db/notification-log.ts` (la tabella e le sue query). Qui sopra ci
 * sono le due cose che ogni scrittore deve fare e che nessuno deve poter
 * dimenticare: il cancello dei topic ARCHIVIATI, e il fronte `notification:new`
 * per le finestre aperte. Scritte in un posto solo perché gli scrittori sono
 * due — la rotta (banner del client) e i trigger della push — e una regola
 * copiata due volte diverge alla prima modifica.
 *
 * Il cablaggio (broadcast + lettura del topic) è INIETTATO al bootstrap, come
 * per `configurePushTriggers`: il modulo resta senza dipendenze sul contesto
 * dell'app e i test lo montano con due funzioni finte.
 */

import { recordNotification } from "./db/notification-log";
import { countUnseenNotifications, markTargetNotificationsSeen } from "./db/notification-log";
import type { NotificationRecordInput, NotificationRow } from "../shared/notification-log";

let announce: ((row: NotificationRow, unseen: number) => void) | null = null;
let announceSeen: ((unseen: number) => void) | null = null;
let topicArchived: ((topicId: string) => boolean) | null = null;

export function configureNotificationRegistry(opts: {
  /** Dillo a tutte le finestre: contatore live + ultima riga. */
  announce: (row: NotificationRow, unseen: number) => void;
  /**
   * The same, the other way round: rows CLEARED, so the counter alone. It sits
   * next to `announce` on purpose - lighting the bell and clearing it are one
   * fact seen from two sides, and keeping them apart is how 400 unseen rows
   * accumulated against ten live signals.
   */
  announceSeen: (unseen: number) => void;
  /**
   * Questo topic è archiviato? OBBLIGATORIO di proposito. Le sessioni dei topic
   * archiviati hanno già notificato per mesi dopo che la chat era sparita
   * dall'interfaccia: il registro non deve diventare il posto dove quel rumore
   * si accumula per sempre. Un default permissivo rimetterebbe il difetto in
   * piedi in silenzio il giorno in cui il cablaggio si perde.
   */
  isTopicArchived: (topicId: string) => boolean;
}): void {
  announce = opts.announce;
  announceSeen = opts.announceSeen;
  topicArchived = opts.isTopicArchived;
}

/** Solo per i test. */
export function __resetNotificationRegistry(): void {
  announce = null;
  announceSeen = null;
  topicArchived = null;
}

/**
 * Scrivi la riga, e se è NUOVA annunciala. `null` quando non è stata scritta:
 * doppione entro la finestra di dedup, topic archiviato, o errore di scrittura.
 *
 * Il valore di ritorno NON è decorativo: solo una riga nuova alza il contatore,
 * e solo una riga nuova merita il fronte. È anche la difesa contro la trappola
 * del boot — se all'avvio qualcuno rigioca eventi vecchi, il dedup li riconosce
 * e la cronologia non li ripresenta come nuovi.
 */
export function recordAndAnnounce(input: NotificationRecordInput): NotificationRow | null {
  if (input.targetKind === "topic" && input.targetId && topicArchived?.(input.targetId)) return null;
  const row = recordNotification(input);
  if (!row) return null;
  try {
    announce?.(row, countUnseenNotifications());
  } catch (err) {
    console.warn("[notification-log] announce failed:", (err as Error)?.message || err);
  }
  return row;
}

/**
 * LOOKING AT THE THING IS HAVING SEEN IT, from the server side.
 *
 * `markTargetNotificationsSeen` knows how to clear the rows but not how to tell
 * anyone, and the counter lives in EVERY open window: without the edge, whoever
 * has the app in front of them keeps seeing the bell lit on a task they just
 * approved, until they reload.
 *
 * Zero rows touched means there was nothing to clear: no edge, so clients are
 * not woken for nothing. Same discipline as `recordAndAnnounce`, reversed.
 */
export function markTargetSeenAndAnnounce(targetKind: string, targetId: string): number {
  const changed = markTargetNotificationsSeen(targetKind, targetId);
  if (changed <= 0) return 0;
  try {
    announceSeen?.(countUnseenNotifications());
  } catch (err) {
    console.warn("[notification-log] announce seen failed:", (err as Error)?.message || err);
  }
  return changed;
}
