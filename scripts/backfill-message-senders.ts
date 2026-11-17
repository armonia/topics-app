#!/usr/bin/env bun
/**
 * Dà il mittente vero ai messaggi utente già in archivio arrivati dai canali.
 *
 * Fino all'introduzione di `sender` su `POST /api/chat` i turni dei canali
 * risultavano tutti del proprietario; il mittente stava solo nel testo, come
 * `<messaggio da="Nome (id)">` o `<messaggio da="Nome (id)" proprietario="sì">`.
 * Qui l'ultimo tag di ogni messaggio diventa l'autore: proprietario → persona
 * predefinita, altrimenti la persona legata a (canale, id), creata se manca.
 *
 * Il canale si ricava dalla forma dell'id (numero lungo = discord, telefono o
 * jid WhatsApp = whatsapp), altrimenti `legacy`. Un tag senza id fra parentesi
 * usa il testo intero come id. Dry run di default, `--apply` scrive. Rieseguibile:
 * a ogni giro ricalcola gli stessi autori.
 *
 *   bun run scripts/backfill-message-senders.ts [--apply] [--db PATH]
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { actingPersonId } from "../server/lib/orgs";
import { normalizeExternalId, personForIdentity } from "../server/lib/person-identities";

const TAG = /<messaggio da="([^"]*)"([^>]*)>/g;

export interface ParsedTag { name: string; externalId: string; channel: string; owner: boolean }

/** Il canale dalla forma dell'id; `legacy` quando non si riconosce. */
export function channelOf(id: string): { channel: string; id: string } {
  if (/^\+?\d{6,15}(@(s\.whatsapp\.net|c\.us))?$/i.test(id)) return { channel: "whatsapp", id: normalizeExternalId("whatsapp", id) };
  if (/^\d{17,20}$/.test(id)) return { channel: "discord", id };
  return { channel: "legacy", id };
}

/** L'ultimo tag `<messaggio da=…>` di un testo, o null. */
export function lastSenderTag(content: string): ParsedTag | null {
  let last: RegExpExecArray | null = null, m: RegExpExecArray | null;
  TAG.lastIndex = 0;
  while ((m = TAG.exec(content))) last = m;
  if (!last) return null;
  const raw = last[1]!.trim();
  const owner = /proprietario="s[iì]"/.test(last[2] ?? "");
  const paren = raw.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  const name = paren ? paren[1]!.split(",")[0]!.trim() : "";
  const { channel, id } = channelOf((paren ? paren[2]! : raw).trim());
  return { name: name || id, externalId: id, channel, owner };
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
    for (const r of rows) {
      const tag = lastSenderTag(r.content);
      if (!tag) continue;
      let pid: string | null;
      if (tag.owner) { pid = owner; res.ownerRows++; }
      else pid = personForIdentity(db, tag.channel, tag.externalId, tag.name);
      if (!pid) continue;
      names.set(pid, tag.owner ? "(proprietario)" : tag.name);
      res.byPerson.set(pid, (res.byPerson.get(pid) ?? 0) + 1);
      if (pid !== r.pid) { update.run(pid, r.id); res.changed++; }
    }
    res.created = (db.query("SELECT COUNT(*) n FROM person_identities").get() as { n: number }).n - before;
    // Il dry run gira nella stessa transazione e la annulla: stessi numeri, niente scritto.
    if (!opts.apply) throw new DryRun();
  };
  try { db.transaction(run)(); } catch (e) { if (!(e instanceof DryRun)) throw e; }
  const labelled = new Map<string, number>();
  for (const [pid, n] of res.byPerson) labelled.set(`${names.get(pid)} [${pid.slice(0, 8)}]`, n);
  res.byPerson = labelled;
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
