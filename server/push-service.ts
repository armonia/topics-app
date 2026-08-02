import webpush from "web-push";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { getDatabase } from "./db";
import { resolveStateDir } from "./lib/data-dir";

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

/** La riga come sta in SQLite: colonne piatte. */
interface PushSubscriptionRow {
  endpoint: string;
  keys_p256dh: string;
  keys_auth: string;
}

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

export async function sendPushToAll(payload: { title: string; body: string; tag?: string; url?: string }) {
  initVapid();
  const db = getDatabase();
  const subs = db.query("SELECT endpoint, keys_p256dh, keys_auth FROM push_subscriptions").all() as PushSubscriptionRow[];

  if (subs.length === 0) return;

  const jsonPayload = JSON.stringify(payload);
  const results = await Promise.allSettled(
    subs.map(sub =>
      webpush.sendNotification(
        toPushSubscription(sub),
        jsonPayload
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
