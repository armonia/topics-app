import webpush from "web-push";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { getDatabase } from "./db";
import { resolveStateDir } from "./lib/data-dir";
import { DEFAULT_WHEN_OPEN, parseWhenOpen } from "./push-devices";
import { deliverableSubscriptions } from "./push-recipients";
import { deliverPush, type VapidDetails } from "./push-delivery";
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
    // Owner-only: the private key signs every push this machine sends.
    writeFileSync(keysPath, JSON.stringify(vapidKeys, null, 2), { mode: 0o600 });
    console.log("[Push] Generated new VAPID keys");
  }

  // VAPID "subject" must be a mailto: or https: URL identifying the app
  // operator. Override via VAPID_SUBJECT env var; the default is a neutral
  // placeholder so the public repo ships no private contact/host info.
  webpush.setVapidDetails(
    vapidSubject(),
    vapidKeys!.publicKey,
    vapidKeys!.privateKey
  );

  return vapidKeys!;
}

function vapidSubject(): string {
  return process.env.VAPID_SUBJECT || "mailto:admin@example.com";
}

/** The signing identity, passed explicitly to every request rather than read
 *  from web-push's global state. */
function vapidDetails(): VapidDetails {
  const keys = initVapid();
  return { subject: vapidSubject(), publicKey: keys.publicKey, privateKey: keys.privateKey };
}

export function getVapidPublicKey(): string {
  const keys = initVapid();
  return keys.publicKey;
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

  // One payload PER DEVICE: the "when open" preference decides who draws the
  // banner (service worker or page) and travels with the message, so the
  // worker never keeps a copy of it that can go stale.
  await deliverPush(
    subs.map((sub) => ({
      endpoint: sub.endpoint,
      keys_p256dh: sub.keys_p256dh,
      keys_auth: sub.keys_auth,
      label: sub.device_label,
      body: JSON.stringify({ ...payload, whenOpen: parseWhenOpen(sub.when_open) ?? DEFAULT_WHEN_OPEN }),
    })),
    {
      tag: payload.tag ?? "untagged",
      vapid: vapidDetails(),
      onExpired: (endpoint) => db.run("DELETE FROM push_subscriptions WHERE endpoint = ?", [endpoint]),
    },
  );
}
