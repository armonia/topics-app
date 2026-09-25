// Removes the bare copies the adopted-session import sweep wrote of turns that
// Topics itself had already streamed and saved.
//
//   bun run scripts/dedupe-imported-claude-messages.ts [--db data/topics.db] [--session <key>] [--apply]
//
// Dry run by default: prints how many rows it WOULD delete, per session, and
// writes nothing. `--apply` deletes them in one transaction.
//
// What counts as a copy: in a session that was ADOPTED (claude_code_sessions
// .import_offset not null), two rows with the same role and the same non-empty
// content, at most 15 minutes apart, where one was saved by the stream (it has
// `model` or `blocks`) and the other has neither (the importer never sets
// them). Only the bare one is deleted, never the other. Matching is one to one:
// each streamed row absorbs at most its nearest bare twin, so two identical
// answers that really happened twice are left alone.
//
// The copy is a node in the message tree: it was the thread tail when the next
// turn began, so that turn's first row has it as parent. Its children are moved
// to its own parent before it goes, or the thread would break there. A copy that
// something else points at (a pin, a mention, a compaction marker) is skipped.
//
// Idempotent: once the copies are gone nothing matches, and a second run
// reports 0.

export {}; // top-level await needs a module

import { Database } from "bun:sqlite";

const argv = process.argv.slice(2);
function opt(name: string, fallback: string | null): string | null {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
}
const DB_PATH = opt("db", "data/topics.db")!;
const SESSION = opt("session", null);
const APPLY = argv.includes("--apply");
const WINDOW_SECONDS = 15 * 60;

const db = APPLY ? new Database(DB_PATH) : new Database(DB_PATH, { readonly: true });
db.run("PRAGMA busy_timeout = 10000");
if (APPLY) db.run("PRAGMA foreign_keys = ON");

interface Pair { sessionKey: string; keepId: string; bareId: string; gap: number }

const pairs = db.prepare(`
  SELECT a.session_key AS sessionKey, a.id AS keepId, b.id AS bareId,
         ABS(julianday(a.timestamp) - julianday(b.timestamp)) * 86400 AS gap
    FROM messages a
    JOIN messages b
      ON b.session_key = a.session_key AND b.role = a.role AND b.content = a.content AND b.id <> a.id
    JOIN claude_code_sessions c ON c.session_key = a.session_key AND c.import_offset IS NOT NULL
   WHERE a.content <> ''
     AND (a.model IS NOT NULL OR a.blocks IS NOT NULL)
     AND b.model IS NULL AND b.blocks IS NULL
     AND ABS(julianday(a.timestamp) - julianday(b.timestamp)) * 86400 <= ?
     AND (? IS NULL OR a.session_key = ?)
   ORDER BY gap ASC
`).all(WINDOW_SECONDS, SESSION, SESSION) as Pair[];

const referenced = db.prepare(`
  SELECT (SELECT COUNT(*) FROM topic_pinned_messages WHERE message_id = ?1)
       + (SELECT COUNT(*) FROM task_comments WHERE message_id = ?1)
       + (SELECT COUNT(*) FROM mentions WHERE message_id = ?1)
       + (SELECT COUNT(*) FROM compaction_markers WHERE after_message_id = ?1) AS n
`);

// Nearest pairs first: each streamed row and each bare row is used once.
const usedKeep = new Set<string>();
const targets = new Map<string, string>(); // bareId -> sessionKey
let skipped = 0;
for (const p of pairs) {
  if (usedKeep.has(p.keepId) || targets.has(p.bareId)) continue;
  if ((referenced.get(p.bareId) as { n: number }).n > 0) { skipped += 1; continue; }
  usedKeep.add(p.keepId);
  targets.set(p.bareId, p.sessionKey);
}

const perSession = new Map<string, number>();
for (const key of targets.values()) perSession.set(key, (perSession.get(key) ?? 0) + 1);

console.log(`${APPLY ? "APPLY" : "DRY RUN"} on ${DB_PATH}${SESSION ? ` (session ${SESSION})` : ""}`);
for (const [key, n] of [...perSession].sort((x, y) => y[1] - x[1])) console.log(`  ${key}: ${n}`);
console.log(`rows to delete: ${targets.size}${skipped ? ` (${skipped} skipped: referenced elsewhere)` : ""}`);

if (APPLY && targets.size) {
  const reparent = db.prepare(
    `UPDATE messages SET parent_id = (SELECT parent_id FROM messages WHERE id = ?1) WHERE parent_id = ?1`,
  );
  const remove = db.prepare(`DELETE FROM messages WHERE id = ?`);
  db.transaction(() => {
    for (const id of targets.keys()) {
      reparent.run(id);
      remove.run(id);
    }
  })();
  console.log(`deleted: ${targets.size}`);
}
