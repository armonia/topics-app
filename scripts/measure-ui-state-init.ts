/**
 * Quanto pesa il frame `ui-state:init` — prima e dopo il filtro delle chiavi
 * per-task del browser (`task-browser-tabs:*`, `task-browser-layout:*`).
 *
 * Il numero che conta è il payload che il server manda a OGNI client a OGNI
 * riconnessione, quindi si misura sul JSON del frame (`{data, meta}`), non sulle
 * righe del db. Si legge una COPIA del db, mai quello vivo.
 *
 *   bun run scripts/measure-ui-state-init.ts <path/topics.db>
 */
import { Database } from "bun:sqlite";

const path = process.argv[2];
if (!path) { console.error("uso: bun run scripts/measure-ui-state-init.ts <path/topics.db>"); process.exit(2); }

const db = new Database(path, { readonly: true });
const rows = db.query("SELECT key, value, payload_version, server_seq FROM ui_state").all() as
  { key: string; value: string; payload_version: number; server_seq: number }[];

const EXCLUDED = ["task-browser-tabs:", "task-browser-layout:"];
const isExcluded = (k: string) => EXCLUDED.some((p) => k.startsWith(p));

function frameBytes(rs: typeof rows): number {
  const data: Record<string, unknown> = {};
  const meta: Record<string, unknown> = {};
  for (const r of rs) {
    try { data[r.key] = JSON.parse(r.value); } catch { data[r.key] = r.value; }
    meta[r.key] = { payload_version: r.payload_version ?? 1, server_seq: r.server_seq ?? 0 };
  }
  return Buffer.byteLength(JSON.stringify({ type: "ui-state:init", data, meta }), "utf8");
}

const kept = rows.filter((r) => !isExcluded(r.key));
const dropped = rows.filter((r) => isExcluded(r.key));
const before = frameBytes(rows);
const after = frameBytes(kept);
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

console.log(`righe ui_state:      ${rows.length}  (per-task: ${dropped.length})`);
console.log(`ui-state:init PRIMA: ${kb(before)}`);
console.log(`ui-state:init DOPO:  ${kb(after)}`);
console.log(`risparmio:           ${kb(before - after)}  (${((1 - after / before) * 100).toFixed(1)}%)`);
