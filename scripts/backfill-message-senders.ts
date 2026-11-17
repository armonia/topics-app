#!/usr/bin/env bun
/**
 * Dà il mittente vero ai messaggi utente già in archivio arrivati dai canali.
 *
 * Fino all'introduzione di `sender` su `POST /api/chat` i turni dei canali
 * risultavano tutti del proprietario; il mittente stava solo nel testo, come
 * `<messaggio da="Nome (id)">` o `<messaggio da="Nome (id)" proprietario="sì">`.
 * Qui il mittente del messaggio diventa l'autore (vedi `lastSenderTag`): proprietario → persona
 * predefinita, altrimenti la persona legata a (canale, id), creata se manca. Tocca solo i messaggi
 * senza autore o con quello del proprietario.
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

/**
 * Il mittente di un testo dai suoi tag `<messaggio da=…>`. Un messaggio unito può portarne più d'uno: vale
 * l'ultimo tag di una persona esterna, se c'è, perché è il lavoro chiesto da fuori che il proprietario
 * sta solo inoltrando o commentando; altrimenti l'ultimo del proprietario. Un tag senza id (`-`, vuoto)
 * è il sistema (cron, giri) e non è nessuno: null.
 */
export function lastSenderTag(content: string): ParsedTag | null {
  const tags = senderTags(content);
  if (!tags.length) return null;
  return [...tags].reverse().find((t) => !t.owner) ?? tags[tags.length - 1]!;
}

/** Tutti i tag di mittente di un testo, nell'ordine, senza quelli di sistema. */
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
    // Gli id che compaiono almeno una volta col segno di proprietario sono suoi anche dove il segno manca
    // (i messaggi più vecchi non lo portavano): si legano a lui prima di tutto, così non diventano persone.
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
      // Si scrive solo dove l'autore manca o è il proprietario messo dal loopback: un autore già giusto,
      // o corretto a mano, resta com'è anche a un secondo giro.
      if (pid !== r.pid && (r.pid === null || r.pid === owner)) { update.run(pid, r.id); res.changed++; }
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
