#!/usr/bin/env bun
/**
 * Gives the real sender to archived user messages that came from the channels.
 *
 * Until `sender` existed on `POST /api/chat`, every channel turn belonged to
 * the owner; the sender lived only in the text, as
 * `<messaggio da="Nome (id)">` or `<messaggio da="Nome (id)" proprietario="sì">`. allow-italian: the literal tag the channels write
 * Here the message's sender becomes its author (see `lastSenderTag`): owner → default
 * person, otherwise the person bound to (channel, id), created if missing. It touches only
 * messages with no author or with the owner as author.
 *
 * The channel comes from the shape of the id (long number = discord, phone or
 * WhatsApp jid = whatsapp), otherwise `legacy`. A tag with no id in brackets
 * uses the whole text as id. Dry run by default, `--apply` writes. Rerunnable:
 * every run computes the same authors.
 *
 *   bun run scripts/backfill-message-senders.ts [--apply] [--db PATH]
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { actingPersonId } from "../server/lib/orgs";
import { normalizeExternalId, personForIdentity } from "../server/lib/person-identities";

const TAG = /<messaggio da="([^"]*)"([^>]*)>/g;

export interface ParsedTag { name: string; externalId: string; channel: string; owner: boolean }

/** The channel from the shape of the id; `legacy` when not recognised. */
export function channelOf(id: string): { channel: string; id: string } {
  if (/^\+?\d{6,15}(@(s\.whatsapp\.net|c\.us))?$/i.test(id)) return { channel: "whatsapp", id: normalizeExternalId("whatsapp", id) };
  if (/^\d{17,20}$/.test(id)) return { channel: "discord", id };
  return { channel: "legacy", id };
}

/**
 * The sender of a text from its `<messaggio da=...>` tags. A merged message may carry several: the last
 * tag of an external person wins, if any, because that is work asked from outside that the owner is only
 * forwarding or commenting; otherwise the owner's last one. A tag with no id (`-`, empty)
 * is the system (cron, rounds) and is nobody: null.
 */
export function lastSenderTag(content: string): ParsedTag | null {
  const tags = senderTags(content);
  if (!tags.length) return null;
  return [...tags].reverse().find((t) => !t.owner) ?? tags[tags.length - 1]!;
}

/** Every sender tag of a text, in order, without the system ones. */
export function senderTags(content: string): ParsedTag[] {
  const tags: ParsedTag[] = [];
  let m: RegExpExecArray | null;
  TAG.lastIndex = 0;
  while ((m = TAG.exec(content))) {
    const raw = m[1]!.trim();
    const owner = /proprietario="s[iì]"/.test(m[2] ?? "");
    const paren = raw.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    const rawId = (paren ? paren[2]! : raw).trim();
    if (!owner && (!rawId || rawId === "-")) continue;
    const name = paren ? paren[1]!.split(",")[0]!.trim() : "";
    const { channel, id } = channelOf(rawId);
    tags.push({ name: name || id, externalId: id, channel, owner });
  }
  return tags;
}

export interface BackfillResult { scanned: number; changed: number; ownerRows: number; created: number; byPerson: Map<string, number> }

export function backfillMessageSenders(db: Database, opts: { apply: boolean }): BackfillResult {
  const owner = actingPersonId(db, null);
  const rows = db.query(`SELECT id, author_person_id pid, substr(content, 1, 20000) content FROM messages
    WHERE role = 'user' AND content LIKE '%<messaggio da=%'`).all() as Array<{ id: string; pid: string | null; content: string }>;
  const before = (db.query("SELECT COUNT(*) n FROM person_identities").get() as { n: number }).n;
  const res: BackfillResult = { scanned: rows.length, changed: 0, ownerRows: 0, created: 0, byPerson: new Map() };
  const update = db.query("UPDATE messages SET author_person_id = ? WHERE id = ?");
  const names = new Map<string, string>();
  const run = () => {
    // Ids seen at least once with the owner mark are the owner's even where the mark is missing
    // (older messages did not carry it): they are bound to the owner first, so they do not become people.
    const bind = db.query("INSERT OR IGNORE INTO person_identities (channel, external_id, person_id, created_at) VALUES (?, ?, ?, ?)");
    if (owner) for (const r of rows) for (const t of senderTags(r.content)) if (t.owner) bind.run(t.channel, t.externalId, owner, Date.now());
    for (const r of rows) {
      const tag = lastSenderTag(r.content);
      if (!tag) continue;
      let pid: string | null;
      if (tag.owner) { pid = owner; res.ownerRows++; }
      else pid = personForIdentity(db, tag.channel, tag.externalId, tag.name);
      if (!pid) continue;
      names.set(pid, tag.owner ? "(proprietario)" : tag.name);
      res.byPerson.set(pid, (res.byPerson.get(pid) ?? 0) + 1);
      // Write only where the author is missing or is the owner set by loopback: an author already right,
      // or fixed by hand, stays as it is on a second run too.
      if (pid !== r.pid && (r.pid === null || r.pid === owner)) { update.run(pid, r.id); res.changed++; }
    }
    res.created = (db.query("SELECT COUNT(*) n FROM person_identities").get() as { n: number }).n - before;
    // The dry run runs in the same transaction and rolls it back: same numbers, nothing written.
    if (!opts.apply) throw new DryRun();
  };
  try { db.transaction(run)(); } catch (e) { if (!(e instanceof DryRun)) throw e; }
  const named = new Map<string, number>();
  for (const [pid, n] of res.byPerson) named.set(`${names.get(pid)} [${pid.slice(0, 8)}]`, n);
  res.byPerson = named;
  return res;
}

class DryRun extends Error {}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--db");
  const dbPath = i >= 0 && args[i + 1] ? args[i + 1]! : process.env.TOPICS_DB ?? join(import.meta.dir, "..", "data", "topics.db");
  const apply = args.includes("--apply");
  const db = new Database(dbPath);
  db.run("PRAGMA busy_timeout = 5000");
  const r = backfillMessageSenders(db, { apply });
  console.log(`${apply ? "scritto" : "dry run"}: ${r.scanned} messaggi con mittente, ${r.changed} autori cambiati, ${r.ownerRows} del proprietario, ${r.created} identità nuove`);
  for (const [k, n] of [...r.byPerson].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${String(n).padStart(6)}  ${k}`);
}
