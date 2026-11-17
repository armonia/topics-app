/**
 * THE REAL SENDER of a message that came from an external channel.
 *
 * Channels (WhatsApp, Discord...) come in over loopback, where `autoreDaIdentita`
 * falls back to the owner, so every message from a client or a colleague
 * looked written by the owner. The channel service knows who wrote and
 * declares it in the `sender` field of `POST /api/chat`; here that external id
 * becomes a person, created the first time and reused after.
 *
 * Trusting the field is safe only for whoever already administers the machine:
 * a guest could attribute a message to anyone. `senderAllowed` decides it.
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

/** The body's `sender` field, validated; null when missing or malformed. */
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
 * The same WhatsApp number arrives as `+39...`, `39...@s.whatsapp.net`, `39...@c.us`:
 * one form, with no suffix and no `+`, so it stays one person.
 */
export function normalizeExternalId(channel: string, id: string): string {
  const s = id.trim();
  if (channel !== "whatsapp") return s;
  return s.replace(/@(s\.whatsapp\.net|c\.us)$/i, "").replace(/^\+/, "");
}

/** Only the owner (loopback included) may declare who wrote. */
export function senderAllowed(identity: { role: "owner" | "guest"; delegatedAuthorizationId?: string } | null | undefined): boolean {
  if (!identity) return true;
  return identity.role === "owner" && !identity.delegatedAuthorizationId;
}

/**
 * The person of an external id: the one already bound, or a new `people` row
 * bound now. The name is written only at birth: renaming a person in Topics
 * is not undone by the channel.
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

/** The author of a message with `sender`: the default owner, or the channel's person. */
export function authorForSender(db: Db, sender: Sender): { authorPersonId: string | null; authorDeviceId: null } {
  if (sender.owner) return { authorPersonId: actingPersonId(db, null), authorDeviceId: null };
  return { authorPersonId: personForIdentity(db, sender.channel, sender.id, sender.name), authorDeviceId: null };
}
