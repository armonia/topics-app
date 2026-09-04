/**
 * DOVE PORTA il click su un banner. Una regola sola per le due superfici che un
 * banner puo' avere: quello nativo (guscio Tauri) e quello web.
 *
 * Il bersaglio e' lo stesso oggetto che il REGISTRO delle notifiche gia'
 * conosce (`shared/notification-log`: `task` oppure `topic`), e non e' un
 * dettaglio: la riga di cronologia e la notifica che l'ha generata devono
 * atterrare nello stesso posto. Prima non era cosi'. Il registro riceveva il
 * bersaglio (task o topic) e il banner riceveva solo il `taskId`, quindi ogni
 * notifica di CHAT (fine turno, messaggio nuovo, terminale) partiva senza
 * destinazione: il click alzava la finestra e finiva li', mentre la stessa
 * notifica aperta dalla cronologia apriva la conversazione.
 *
 * ── Il token, e perche' il campo di rete si chiama ancora `taskId` ───────────
 * Il guscio nativo non interpreta niente: prende una stringa, la infila
 * nell'identificatore della notifica (`topics-task-<token>`) e al click la
 * ridà al client cosi' com'e' (`window.__topicsOpenTask`). E' trasporto puro,
 * quindi ci passa qualunque token che rispetti il suo filtro di caratteri
 * (alfanumerici, `-`, `_`).
 *
 * Da qui la scelta: il bersaglio viaggia CODIFICATO dentro quel campo invece di
 * chiederne uno nuovo. Un campo nuovo funzionerebbe solo con un guscio
 * ricompilato, e il guscio e' il pezzo che si aggiorna piu' di rado: sui banner
 * dei gusci gia' installati il click resterebbe rotto esattamente come oggi.
 * Cosi' invece la correzione vale subito, anche sull'app gia' installata.
 *
 * La codifica e' priva di ambiguita': un id di task e' un UUID (solo cifre
 * esadecimali e trattini), quindi non puo' cominciare per `topic_`.
 */
import { notificationTargetUrl, type NotificationTargetKind } from '../../../../shared/notification-log';
import { openDeepLinkInApp } from '../deepLinkEntry';

export interface NotifyTarget {
  kind: NotificationTargetKind;
  id: string;
}

/** Il prefisso che distingue un topic da un task nel token. */
const TOPIC_PREFIX = 'topic_';

/** Lo stesso filtro del guscio (`macos_notifications.rs`): un token che non lo
 *  passa verrebbe scartato di la' in silenzio, quindi non lo mandiamo affatto. */
const TOKEN_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Il bersaglio nella forma che il guscio sa trasportare, o `null` se non c'e'
 * niente da trasportare (nessun bersaglio, oppure un id con caratteri che il
 * guscio scarterebbe). `null` = banner senza click, cioe' il comportamento che
 * quella notifica aveva comunque.
 */
export function encodeNotifyTarget(target: NotifyTarget | null | undefined): string | null {
  if (!target?.id) return null;
  const token = target.kind === 'topic' ? `${TOPIC_PREFIX}${target.id}` : target.id;
  return TOKEN_RE.test(token) ? token : null;
}

/** Il verso opposto: il token che torna dal guscio ridiventa un bersaglio. */
export function decodeNotifyTarget(token: string | null | undefined): NotifyTarget | null {
  if (!token || !TOKEN_RE.test(token)) return null;
  if (token.startsWith(TOPIC_PREFIX)) {
    const id = token.slice(TOPIC_PREFIX.length);
    return id ? { kind: 'topic', id } : null;
  }
  return { kind: 'task', id: token };
}

/**
 * Apri IN-APP il bersaglio di un banner. Passa da `openDeepLinkInApp`, la porta
 * unica dei deep-link: un click sul banner e un click sulla riga di cronologia
 * percorrono la stessa strada e non possono divergere.
 *
 * Torna `false` quando non c'era niente da aprire, cosi' il chiamante puo'
 * distinguere «bersaglio assente» da «bersaglio aperto» invece di indovinare.
 */
export function openNotifyTarget(target: NotifyTarget | null | undefined): boolean {
  const url = notificationTargetUrl(target?.kind, target?.id);
  return url ? openDeepLinkInApp(url) : false;
}

/** Il gemello per chi ha in mano il token e non il bersaglio: il guscio nativo,
 *  che al click ridà esattamente la stringa che gli era stata data. */
export function openNotifyToken(token: string | null | undefined): boolean {
  return openNotifyTarget(decodeNotifyTarget(token));
}
