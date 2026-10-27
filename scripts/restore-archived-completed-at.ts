#!/usr/bin/env bun
/**
 * scripts/restore-archived-completed-at.ts - puts archived cards back to done
 * with the closing date they had (card 600feca6).
 *
 * The bug fixed in #471 sent 49 done cards back to backlog while they were
 * being archived. The TSV lists them with their original `completed_at`; this
 * goes through the same PATCH the board uses, with the date spelled out, so a
 * card whose date was already overwritten (a22b3191) comes back too.
 *
 *   bun run scripts/restore-archived-completed-at.ts <file.tsv>          # what it would do
 *   bun run scripts/restore-archived-completed-at.ts <file.tsv> --apply  # do it, then check
 *
 * Each line needs a card id (whole or prefix) and an ISO UTC date; other
 * columns and a header are ignored. Read-only on the DB: writes go through the
 * running server (`TOPICS_URL`, default https://localhost:3333), which has to
 * carry the fix, so restart it first.
 */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.TOPICS_URL ?? "https://localhost:3333";
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const ID = /^[0-9a-f]{8}(-[0-9a-f-]+)?$/i;

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const apply = args.includes("--apply");
if (!file) {
  console.error("usage: restore-archived-completed-at.ts <file.tsv> [--apply]");
  process.exit(2);
}

interface Row { id: string; project_id: string; status: string; completed_at: string | null; archived: number }

const db = new Database(process.env.TOPICS_DB ?? resolve(ROOT, "data/topics.db"), { readonly: true });
const find = (prefix: string) =>
  db.prepare("SELECT id, project_id, status, completed_at, archived FROM tasks WHERE id LIKE ? || '%'").all(prefix) as Row[];

const wanted: { id: string; at: string }[] = [];
let bad = 0;
for (const [n, line] of readFileSync(file, "utf8").split(/\r?\n/).entries()) {
  const cols = line.split("\t").map((c) => c.trim());
  const id = cols.find((c) => ID.test(c));
  const at = cols.find((c) => ISO_UTC.test(c));
  if (!id && !at) continue; // header or blank line
  if (!id || !at) { console.error(`line ${n + 1}: needs a card id and an ISO UTC date: ${line}`); bad++; continue; }
  wanted.push({ id, at });
}

const plan: { row: Row; at: string }[] = [];
for (const w of wanted) {
  const hits = find(w.id);
  if (hits.length !== 1) { console.error(`${w.id}: ${hits.length} cards match`); bad++; continue; }
  const row = hits[0]!;
  if (row.archived !== 1) { console.error(`${row.id}: not archived, left alone`); bad++; continue; }
  if (row.status === "done" && row.completed_at === w.at) continue;
  plan.push({ row, at: w.at });
}
console.log(`${wanted.length} cards in the file, ${plan.length} to fix, ${bad} problems`);
for (const p of plan) console.log(`  ${p.row.id.slice(0, 8)}  ${p.row.status} ${p.row.completed_at ?? "-"}  ->  done ${p.at}`);

if (apply) {
  for (const { row, at } of plan) {
    const body = row.status === "done" ? { completedAt: at } : { status: "done", completedAt: at };
    // Self-signed certificate of the local server: loopback only, like the
    // other scripts that talk to :3333.
    const res = await fetch(`${BASE}/api/boards/${encodeURIComponent(row.project_id)}/tasks/${row.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      tls: { rejectUnauthorized: false },
    });
    if (!res.ok) { console.error(`${row.id}: PATCH ${res.status} ${await res.text()}`); bad++; }
  }
  // The check reads the row again, it does not trust the 200s.
  let off = 0;
  for (const w of wanted) {
    const row = find(w.id)[0];
    if (!row || row.status !== "done" || row.completed_at !== w.at) {
      off++;
      console.error(`${w.id}: now ${row?.status ?? "missing"} ${row?.completed_at ?? "-"}, expected done ${w.at}`);
    }
  }
  console.log(`check: ${wanted.length - off}/${wanted.length} done with the date from the file`);
  if (off) bad++;
}
db.close();
process.exit(bad ? 1 : 0);
