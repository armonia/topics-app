/**
 * IL MITTENTE VERO di un messaggio arrivato da un canale esterno.
 *
 * I canali (WhatsApp, Discord…) entrano da loopback: `autoreDaIdentita` lì
 * ricade sul proprietario, e così ogni messaggio di un cliente o di un collega
 * risultava scritto da lui. Il servizio dei canali sa chi ha scritto e lo
 * dichiara nel campo `sender` di `POST /api/chat`; qui quell'id esterno diventa
 * una persona, creata la prima volta e poi riusata.
 *
 * Fidarsi del campo è sicuro solo per chi amministra già la macchina: un ospite
 * potrebbe attribuire un messaggio a chiunque. `senderAllowed` lo decide.
 */
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { actingPersonId } from "./orgs";

type Db = Pick<Database, "query" | "transaction">;

export interface Sender {
  channel: string;
  id: string;
  name: string;
  owner?: boolean;
}

/** Il campo `sender` del corpo, validato; null se manca o è malformato. */
export function parseSender(raw: unknown): Sender | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const channel = str(r.channel), id = str(r.id), name = str(r.name);
  if (r.owner === true) return { channel, id, name, owner: true };
  if (!channel || !id) return null;
  return { channel: channel.slice(0, 64), id: id.slice(0, 200), name: (name || id).slice(0, 200) };
}

/**
 * Lo stesso numero WhatsApp arriva come `+39…`, `39…@s.whatsapp.net`, `39…@c.us`:
 * una forma sola, senza suffisso né `+`, perché resti una persona sola.
 */
export function normalizeExternalId(channel: string, id: string): string {
  const s = id.trim();
  if (channel !== "whatsapp") return s;
  return s.replace(/@(s\.whatsapp\.net|c\.us)$/i, "").replace(/^\+/, "");
}

/** Solo il proprietario (loopback compreso) può dichiarare chi ha scritto. */
export function senderAllowed(identity: { role: "owner" | "guest"; delegatedAuthorizationId?: string } | null | undefined): boolean {
  if (!identity) return true;
  return identity.role === "owner" && !identity.delegatedAuthorizationId;
}

/**
 * La persona di un id esterno: quella già legata, oppure una nuova riga di
 * `people` legata adesso. Il nome si scrive solo alla nascita: chi rinomina una
 * persona in Topics non se la vede cambiare dal canale.
 */
export function personForIdentity(db: Db, channel: string, rawId: string, rawName: string, now = Date.now()): string {
  const externalId = normalizeExternalId(channel, rawId);
  const name = rawName.trim() || externalId;
  const found = db.query("SELECT person_id FROM person_identities WHERE channel = ? AND external_id = ?")
    .get(channel, externalId) as { person_id: string } | undefined;
  if (found) return found.person_id;
  const personId = randomUUID();
  db.transaction(() => {
    db.query("INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES (?, ?, ?, 'local', 1, ?)")
      .run(personId, name || externalId, now, now);
    db.query("INSERT INTO person_identities (channel, external_id, person_id, created_at) VALUES (?, ?, ?, ?)")
      .run(channel, externalId, personId, now);
  })();
  return personId;
}

/** L'autore di un messaggio con `sender`: il proprietario predefinito, o la persona del canale. */
export function authorForSender(db: Db, sender: Sender): { authorPersonId: string | null; authorDeviceId: null } {
  if (sender.owner) return { authorPersonId: actingPersonId(db, null), authorDeviceId: null };
  return { authorPersonId: personForIdentity(db, sender.channel, sender.id, sender.name), authorDeviceId: null };
}
