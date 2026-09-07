/**
 * WHAT THE BOOT SWEEP COSTS, MEASURED INSTEAD OF ARGUED.
 *
 * Replays the three SELECTs of the boot sweep (two in `server.ts`, one in
 * `server/lib/verdetto-turno-interrotto.ts`) with the real `decodeCol` on every
 * row, WITH and WITHOUT the archived filter, and prints rows, decoded bytes and
 * milliseconds for each. Nothing is written: the database is opened read-only
 * (`?mode=ro` plus `PRAGMA query_only`), so it can be pointed at a copy of a
 * live database without touching it.
 *
 * Run by hand:
 *   bun run scripts/boot-sweep-probe.ts [path/to/topics.db]
 * With no argument it builds a synthetic database (1.500 archived topics,
 * fat rows) so the measure is reproducible on a machine with no data.
 */
import { Database } from "bun:sqlite";
import { decodeCol, encodeCol } from "../shared/message-blob";
import { NOT_ARCHIVED_SQL } from "../server/lib/archived-scope";

const RUNNING_RE = /"status":"(running|pending|waiting_for_input|awaiting_permission)"/;
const INTERRUPTED_RE = /Interrotto/;

/** The three passes, with the filter spliced in or replaced by a no-op. */
function sweepPasses(filtered: boolean): Array<{ name: string; sql: string; re: RegExp }> {
  const scope = filtered ? NOT_ARCHIVED_SQL : "1 = 1";
  return [
    {
      name: "pass 1 (orphaned running tools)",
      re: RUNNING_RE,
      sql: `SELECT id, session_key, content, tool_calls, blocks FROM messages
            WHERE timestamp >= date('now', '-30 days') AND partial = 0
              AND (tool_calls IS NOT NULL OR blocks IS NOT NULL) AND ${scope}`,
    },
    {
      name: "pass 2 (mute turns)",
      re: INTERRUPTED_RE,
      sql: `SELECT id, blocks FROM messages WHERE role = 'assistant'
              AND blocks IS NOT NULL AND partial = 0
              AND timestamp >= date('now', '-30 days') AND ${scope}`,
    },
    {
      name: "pass 3 (missing explanation)",
      re: INTERRUPTED_RE,
      sql: `SELECT id, tool_calls, blocks FROM messages WHERE role = 'assistant'
              AND (content IS NULL OR trim(content) = '')
              AND timestamp >= date('now', '-30 days') AND partial = 0
              AND (tool_calls IS NOT NULL OR blocks IS NOT NULL) AND ${scope}`,
    },
  ];
}

type Row = { tool_calls?: unknown; blocks?: unknown };

function run(db: Database, filtered: boolean): { rows: number; hits: number; bytes: number; ms: number } {
  let rows = 0, hits = 0, bytes = 0;
  const t0 = performance.now();
  for (const q of sweepPasses(filtered)) {
    for (const r of db.prepare(q.sql).iterate() as Iterable<Row>) {
      rows++;
      const text = (decodeCol(r.tool_calls) ?? "") + (decodeCol(r.blocks) ?? "");
      bytes += text.length;
      if (q.re.test(text)) hits++;
    }
  }
  return { rows, hits, bytes, ms: performance.now() - t0 };
}

/** A database shaped like the one that hurts: mostly archived, fat rows. */
function synthetic(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE messages (id TEXT PRIMARY KEY, session_key TEXT, role TEXT, content TEXT, tool_calls BLOB, blocks BLOB, partial INTEGER DEFAULT 0, timestamp TEXT)`);
  db.run(`CREATE TABLE topics (session_key TEXT, archived INTEGER)`);
  const now = new Date().toISOString();
  const insertMessage = db.prepare(`INSERT INTO messages VALUES (?, ?, 'assistant', '', ?, ?, 0, ?)`);
  const insertTopic = db.prepare(`INSERT INTO topics (session_key, archived) VALUES (?, ?)`);
  const pad = "x".repeat(40_000);
  const blob = (status: string) => encodeCol(JSON.stringify([{ kind: "tool", toolCall: { id: "t", status, output: pad } }]));
  for (let i = 0; i < 1_500; i++) {
    const archived = i >= 30;
    const key = `sk-${i}`;
    insertTopic.run(key, archived ? 1 : 0);
    insertMessage.run(`m${i}`, key, blob("running") as never, blob("running") as never, now);
  }
  return db;
}

const path = process.argv[2];
const db = path ? new Database(`file:${path}?mode=ro`, { strict: false }) : synthetic();
if (path) db.run("PRAGMA query_only = ON");

const before = run(db, false);
const after = run(db, true);
const mb = (n: number) => `${(n / 1_048_576).toFixed(1)} MB`;
console.log(`source: ${path ?? "synthetic (1.500 topics, 30 open)"}`);
for (const [label, m] of [["without filter", before], ["with filter   ", after]] as const) {
  console.log(`${label}  rows ${String(m.rows).padStart(6)}  decoded ${mb(m.bytes).padStart(9)}  hits ${String(m.hits).padStart(5)}  ${m.ms.toFixed(0)} ms`);
}
console.log(`total with filter: ${after.ms.toFixed(0)} ms (bar: < 100 ms)`);
