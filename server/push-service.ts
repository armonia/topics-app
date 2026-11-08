import { createECDH } from "crypto";
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
    vapidKeys = generateVapidKeys();
    mkdirSync(dirname(keysPath), { recursive: true });
    // Owner-only: the private key signs every push this machine sends.
    writeFileSync(keysPath, JSON.stringify(vapidKeys, null, 2), { mode: 0o600 });
    console.log("[Push] Generated new VAPID keys");
  }

  // VAPID "subject" must be a mailto: or https: URL identifying the app
  // operator. Override via VAPID_SUBJECT env var; the default is a neutral
  // placeholder so the public repo ships no private contact/host info.
  //
  // `webpush.setVapidDetails(...)` used to be here, with the static import of
  // `web-push` it required: asn1.js, jws and the rest of the crypto evaluated
  // before `listen` on EVERY boot (~33 ms measured in isolation), to set a
  // global state nobody reads, since `deliverPush` passes explicit credentials
  // on every request (`vapidDetails()` below). Of its work only one thing
  // mattered: a broken keys file or a wrong subject stop the boot instead of
  // silently failing every push. That check stays, without the library.
  assertVapidDetails(vapidSubject(), vapidKeys!);

  return vapidKeys!;
}

/**
 * VAPID keys exactly as `webpush.generateVAPIDKeys()` makes them: an ECDH
 * P-256 pair, uncompressed public key (65 bytes) and private key (32 bytes),
 * base64url, with the same left padding when a buffer comes out short. Written
 * here so the first boot does not have to load `web-push` just for this.
 */
function generateVapidKeys(): VapidKeys {
  const curve = createECDH("prime256v1");
  curve.generateKeys();
  const pad = (buf: Buffer, len: number) => (buf.length < len ? Buffer.concat([Buffer.alloc(len - buf.length), buf]) : buf);
  return {
    publicKey: pad(curve.getPublicKey(), 65).toString("base64url"),
    privateKey: pad(curve.getPrivateKey(), 32).toString("base64url"),
  };
}

/** The same checks as `setVapidDetails`, with the same messages. */
function assertVapidDetails(subject: string, keys: VapidKeys): void {
  let url: URL;
  try { url = new URL(subject); } catch { throw new Error(`Vapid subject is not a valid URL. ${subject}`); }
  if (url.protocol !== "https:" && url.protocol !== "mailto:") {
    throw new Error(`Vapid subject is not an https: or mailto: URL. ${subject}`);
  }
  const decoded = (key: unknown) => (typeof key === "string" && /^[A-Za-z0-9_-]+$/.test(key) ? Buffer.from(key, "base64url").length : -1);
  if (decoded(keys.publicKey) !== 65) throw new Error("Vapid public key should be 65 bytes long when decoded.");
  if (decoded(keys.privateKey) !== 32) throw new Error("Vapid private key should be 32 bytes long when decoded.");
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
  /**
   * How many subjects are lit right now (notifications-redesign, design
   * section 6): the service worker writes it on the app badge, the only way a
   * closed PWA learns the count.
   */
  badge?: number;
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
