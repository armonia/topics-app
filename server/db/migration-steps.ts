import type { Database } from "bun:sqlite";
import { decodeCol } from "../../shared/message-blob";

/**
 * Code that runs INSIDE the transaction of a SQL migration, right after its SQL.
 *
 * Why it exists: `messages.blocks` is stored as a zstd blob above 512 bytes
 * (`encodeCol`, shared/message-blob.ts) and SQLite cannot read zstd, so a data
 * migration written in SQL silently skips every compressed row. The first
 * version of `20261026220625-reprice-tool-costs-truncate.sql` did exactly that:
 * on a copy of the live DB it changed 0 rows, because 1,898 of the 2,065
 * repriced rows keep `blocks` as a blob and `json_valid(blocks)` is 0 for them.
 *
 * The key is the migration FILE NAME: the registry (`schema_migrations`) stays
 * one row per `.sql` file, and the step runs once, with the SQL, in the same
 * transaction: a step that throws rolls the whole migration back and it is not
 * recorded. The runner is `runMigrations` (server/db.ts); the compiled sidecar
 * bundles this module like any other, so disk and embedded runs behave the same.
 */
export const MIGRATION_STEPS: Record<string, (db: Database) => void> = {
  "20261026220625-reprice-tool-costs-truncate.sql": (db) => {
    const changed = truncateToolCostsToTotal(db);
    if (changed > 0) console.log(`[DB] tool costs brought back under the message total on ${changed} message(s)`);
  },
};

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Where an entry of `tool_calls` keeps its cost: on the entry itself. */
const toolCallOf = (entry: unknown): Json | null => (isObject(entry) ? entry : null);
/** Where an entry of `blocks` keeps its cost: on the `toolCall` of a tool block. */
const blockToolCallOf = (entry: unknown): Json | null =>
  isObject(entry) && isObject(entry.toolCall) ? entry.toolCall : null;

/**
 * The stored value of one column with every tool cost scaled so that the tools
 * add up to at most `total`, or null when the column needs no change (nothing
 * readable, no costs, or the tools already fit). The result keeps the form of
 * what was read: text stays text, a blob stays a blob (zstd level 3, like
 * `encodeCol`), so a row never changes storage class because of this.
 */
function scaledColumn(raw: unknown, total: number, holderOf: (entry: unknown) => Json | null): string | Uint8Array | null {
  let parsed: unknown;
  try {
    const text = decodeCol(raw);
    if (!text || !text.includes('"costCents"')) return null;
    parsed = JSON.parse(text);
  } catch {
    // Unreadable (corrupt blob, invalid JSON): leave the row as it is. A throw
    // here would stop the boot on every start, for a row no reader can open.
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const costed: Json[] = [];
  let sum = 0;
  for (const entry of parsed) {
    const holder = holderOf(entry);
    if (holder && typeof holder.costCents === "number") {
      costed.push(holder);
      sum += holder.costCents;
    }
  }
  if (sum <= total) return null;
  // Each tool times total / sum, truncated: the truncated parts add up to at
  // most `total`. The tools' costs before the 24/10 reprice are gone, so the
  // truncated value cannot be recomputed from them.
  for (const holder of costed) holder.costCents = Math.trunc((holder.costCents as number) * total / sum);
  const json = JSON.stringify(parsed);
  return typeof raw === "string" ? json : Bun.zstdCompressSync(Buffer.from(json, "utf8"), { level: 3 });
}

/**
 * The per-tool costs of the 5.5 reprice, back under the message total.
 *
 * 20261024180000-reprice-5-5-history scaled each tool's `costCents` by the
 * message's ratio, ROUNDED and floored at one cent: six 1-cent tools in a
 * 6 cent turn repriced to 4 stay six 1-cent tools. That migration is already
 * applied (production, 24/10), so it is corrected by a new one.
 *
 * On every repriced row (`cost_cents_before_reprice` not null) whose tools add
 * up to MORE than `cost_cents`, each tool is scaled by cost_cents / (sum of the
 * tools) and truncated to whole cents. `tool_calls` and `blocks` are each
 * corrected on their own sum, whether stored as text or as a zstd blob. A row
 * whose tools already fit is not written, so a second run changes nothing.
 *
 * Returns the number of messages written.
 */
function truncateToolCostsToTotal(db: Database): number {
  const ids = (db.query(
    `SELECT id FROM messages
      WHERE cost_cents_before_reprice IS NOT NULL AND cost_cents > 0
        AND (tool_calls IS NOT NULL OR blocks IS NOT NULL)`,
  ).all() as Array<{ id: string }>).map((r) => r.id);
  const read = db.prepare("SELECT cost_cents, tool_calls, blocks FROM messages WHERE id = ?");
  const writeToolCalls = db.prepare("UPDATE messages SET tool_calls = ? WHERE id = ?");
  const writeBlocks = db.prepare("UPDATE messages SET blocks = ? WHERE id = ?");
  let changed = 0;
  for (const id of ids) {
    const row = read.get(id) as { cost_cents: number; tool_calls: unknown; blocks: unknown };
    const toolCalls = scaledColumn(row.tool_calls, row.cost_cents, toolCallOf);
    const blocks = scaledColumn(row.blocks, row.cost_cents, blockToolCallOf);
    if (toolCalls !== null) writeToolCalls.run(toolCalls, id);
    if (blocks !== null) writeBlocks.run(blocks, id);
    if (toolCalls !== null || blocks !== null) changed++;
  }
  return changed;
}
