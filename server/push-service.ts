import webpush from "web-push";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { getDatabase } from "./db";
import { resolveStateDir } from "./lib/data-dir";
import { DEFAULT_WHEN_OPEN, parseWhenOpen } from "./push-devices";
import { deliverableSubscriptions, type DeliverableSubscription } from "./push-recipients";
import type { NotifyAction, NotifyActionRequest } from "../shared/notify-actions";

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

let vapidKeys: VapidKeys | null = null;

export function initVapid(): VapidKeys {
  if (vapidKeys) return vapidKeys;

  // Written on first run when absent → must go to a writable dir, not the
  // read-only app bundle (the file is gitignored and NOT staged, so a fresh
  // download always hits the generate+write path).
  const keysPath = join(resolveStateDir(import.meta.dir), "vapid-keys.json");

  if (existsSync(keysPath)) {
    vapidKeys = JSON.parse(readFileSync(keysPath, "utf-8"));
  } else {
    const generated = webpush.generateVAPIDKeys();
    vapidKeys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
    mkdirSync(dirname(keysPath), { recursive: true });
    writeFileSync(keysPath, JSON.stringify(vapidKeys, null, 2));
    console.log("[Push] Generated new VAPID keys");
  }

  // VAPID "subject" must be a mailto: or https: URL identifying the app
  // operator. Override via VAPID_SUBJECT env var; the default is a neutral
  // placeholder so the public repo ships no private contact/host info.
  const vapidSubject = process.env.VAPID_SUBJECT || "mailto:admin@example.com";
  webpush.setVapidDetails(
    vapidSubject,
    vapidKeys!.publicKey,
    vapidKeys!.privateKey
  );

  return vapidKeys!;
}

export function getVapidPublicKey(): string {
  const keys = initVapid();
  return keys.publicKey;
}

/** La riga come sta in SQLite: colonne piatte. Il tipo vive accanto alla query
 *  che la produce (`push-recipients.ts`) — due dichiarazioni della stessa riga
 *  sono due verità in attesa di separarsi. `when_open` viaggia DENTRO il payload
 *  invece di essere una copia che il service worker si tiene da parte: la
 *  preferenza è per-dispositivo e il mittente la conosce già riga per riga. */
type PushSubscriptionRow = DeliverableSubscription;

/** La forma che vuole webpush: chiavi annidate. NON coincide con la riga, ed è
 *  il motivo per cui esistono entrambi i tipi — l'interfaccia c'era già ma non la
 *  usava nessuno, mentre la query si accontentava di `any[]`: il rimappaggio
 *  colonna→chiave era quindi l'unico punto non controllato dal compilatore. */
interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

function toPushSubscription(row: PushSubscriptionRow): PushSubscription {
  return { endpoint: row.endpoint, keys: { p256dh: row.keys_p256dh, auth: row.keys_auth } };
}

/**
 * Il payload come arriva da `push-triggers`, `whenOpen` a parte — quello lo
 * aggiunge questa funzione, riga per riga, perché è l'unica che conosce il
 * DISPOSITIVO a cui sta spedendo.
 *
 * `actions`/`requests` sono dichiarati anche qui e non solo dal chiamante: la
 * firma stretta di prima compilava lo stesso (un oggetto con proprietà in più
 * passa, se non è un literal), ma diceva il falso — questa funzione inoltra
 * l'intero payload, e i TASTI ci passano dentro. Una firma che tace su ciò che
 * trasporta è il posto esatto in cui, al prossimo giro, qualcuno «pulisce» il
 * payload e i tasti spariscono senza che un tipo protesti.
 */
export interface OutgoingPushPayload {
  title: string;
  body: string;
  tag?: string;
  url?: string;
  actions?: NotifyAction[];
  requests?: Record<string, NotifyActionRequest>;
}

export async function sendPushToAll(payload: OutgoingPushPayload) {
  initVapid();
  const db = getDatabase();
  // Chi riceve lo decide `deliverableSubscriptions`, e la decisione sta in un
  // modulo suo: spento dall'utente E dispositivo ancora vivo sono due domande,
  // e la seconda qui non veniva posta affatto (`WHERE enabled = 1` e basta),
  // quindi un telefono revocato continuava a ricevere per sempre.
  const subs = deliverableSubscriptions(db);

  if (subs.length === 0) return;

  const results = await Promise.allSettled(
    subs.map(sub =>
      webpush.sendNotification(
        toPushSubscription(sub),
        // Un payload PER DISPOSITIVO: la preferenza «ad app aperta» decide chi
        // disegna il banner (service worker o pagina) e viaggia col messaggio,
        // così il worker non deve tenersi una copia che può invecchiare.
        JSON.stringify({ ...payload, whenOpen: parseWhenOpen(sub.when_open) ?? DEFAULT_WHEN_OPEN })
      ).catch(err => {
        // 410 Gone or 404 = subscription expired, remove it
        if (err.statusCode === 410 || err.statusCode === 404) {
          // Bindings in forma di array: è la firma che `Database.run` dichiara.
          // Con `sub` tipizzato `any` il compilatore non poteva dirlo.
          db.run("DELETE FROM push_subscriptions WHERE endpoint = ?", [sub.endpoint]);
          console.log(`[Push] Removed expired subscription`);
        } else {
          console.error(`[Push] Send failed:`, err.statusCode || err.message);
        }
      })
    )
  );

  const sent = results.filter(r => r.status === "fulfilled").length;
  if (sent > 0) console.log(`[Push] Sent to ${sent}/${subs.length} subscribers`);
}
