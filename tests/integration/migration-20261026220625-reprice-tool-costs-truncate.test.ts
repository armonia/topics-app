/**
 * The per-tool costs of the 5.5 reprice, back under the message total:
 * `20261026220625-reprice-tool-costs-truncate.sql`.
 *
 * Every test starts from a DB that already ran `20261024180000-reprice-5-5-history.sql`,
 * like production since 24/10: that migration rounded each tool's scaled cost and
 * floored it at one cent, so many cheap tools could add up to more than the message.
 *
 * Runs the migration FILES, not copies.
 * @covers USAGE-01
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { PROJECT_ROOT } from "./helpers";

const read = (name: string): string =>
  fs.readFileSync(path.join(PROJECT_ROOT, "server/db/migrations", name), "utf-8");
const REPRICE_SQL = read("20261024180000-reprice-5-5-history.sql");
const MIGRATION_SQL = read("20261026220625-reprice-tool-costs-truncate.sql");

interface Row {
  id: string;
  model: string;
  prompt: number;
  cents: number;
  toolCalls?: unknown[];
  blocks?: unknown[];
}

/** A messages table with `rows`, then the 24/10 reprice applied to it. */
function repriced(rows: Row[]): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, model TEXT, cost_cents INTEGER,
    usage_prompt_tokens INTEGER, usage_completion_tokens INTEGER,
    cache_read_tokens INTEGER, cache_creation_tokens INTEGER, cache_creation_1h_tokens INTEGER,
    tool_calls TEXT, blocks TEXT)`);
  const insert = db.prepare(`INSERT INTO messages VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?, ?)`);
  for (const r of rows) {
    insert.run(r.id, r.model, r.cents, r.prompt,
      r.toolCalls ? JSON.stringify(r.toolCalls) : null, r.blocks ? JSON.stringify(r.blocks) : null);
  }
  db.exec(REPRICE_SQL);
  return db;
}

type Raw = { cost: number; before: number | null; t: string | null; b: string | null };
const rawOf = (db: Database, id: string): Raw =>
  db.query("SELECT cost_cents cost, cost_cents_before_reprice before, tool_calls t, blocks b FROM messages WHERE id = ?").get(id) as Raw;

const toolSum = (t: string): number =>
  (JSON.parse(t) as Array<{ costCents?: number }>).reduce((a, x) => a + (x.costCents ?? 0), 0);
const blockSum = (b: string): number =>
  (JSON.parse(b) as Array<{ toolCall?: { costCents?: number } }>).reduce((a, x) => a + (x.toolCall?.costCents ?? 0), 0);

const tools = (cents: number[]) => cents.map((costCents, i) => ({ id: `t${i}`, name: "Read", costCents }));

/** Six one-cent tools in a 6 cent Sonnet 5.5 turn ($3 then): repriced to 4 cents ($2), the tools stay at 6. */
const sixOneCent = (id: string): Row => ({
  id, model: "claude-sonnet-5-5", prompt: 20_000, cents: 6,
  toolCalls: tools([1, 1, 1, 1, 1, 1]),
  blocks: tools([1, 1, 1, 1, 1, 1]).map((toolCall) => ({ kind: "tool", toolCall })),
});

describe("the tools of a repriced message add up to at most its total", () => {
  test("six 1-cent tools in a turn repriced from 6 to 4 cents", () => {
    const db = repriced([sixOneCent("many")]);
    const was = rawOf(db, "many");
    expect([was.before, was.cost]).toEqual([6, 4]);
    expect(toolSum(was.t!)).toBe(6); // what the 24/10 reprice left in production

    db.exec(MIGRATION_SQL);
    const out = rawOf(db, "many");
    expect(out.cost).toBe(4);
    expect(toolSum(out.t!)).toBeLessThanOrEqual(4);
    expect(blockSum(out.b!)).toBeLessThanOrEqual(4);
  });

  test("each tool scaled by total / sum of the tools and truncated; other fields and shapes kept", () => {
    const db = repriced([{
      id: "mixed", model: "claude-sonnet-5-5", prompt: 20_000, cents: 6,
      toolCalls: [{ id: "a", name: "Bash", costCents: 3, tokens: 100 }, { id: "b", name: "Read", costCents: 3 }, { id: "c", name: "Grep" }],
      blocks: [
        { kind: "tool", toolCall: { id: "a", name: "Bash", costCents: 3 } },
        { kind: "text", text: "ok" },
        { kind: "tool", toolCall: { id: "b", name: "Read", costCents: 3 } },
      ],
    }]);
    // The reprice: 3 * 4/6 = 2 each, 4 in all, already under the 4 cent total: untouched.
    expect(toolSum(rawOf(db, "mixed").t!)).toBe(4);
    db.exec("UPDATE messages SET cost_cents = 3 WHERE id = 'mixed'");

    db.exec(MIGRATION_SQL);
    const out = rawOf(db, "mixed");
    expect(out.t!.startsWith("[{")).toBe(true);
    // 2 * 3/4 = 1.5, truncated to 1.
    expect(JSON.parse(out.t!)).toEqual([
      { id: "a", name: "Bash", costCents: 1, tokens: 100 },
      { id: "b", name: "Read", costCents: 1 },
      { id: "c", name: "Grep" },
    ]);
    expect(JSON.parse(out.b!)).toEqual([
      { kind: "tool", toolCall: { id: "a", name: "Bash", costCents: 1 } },
      { kind: "text", text: "ok" },
      { kind: "tool", toolCall: { id: "b", name: "Read", costCents: 1 } },
    ]);
  });

  test("tools that already fit, and rows the reprice did not touch, are left alone", () => {
    const db = repriced([
      // Repriced, tools under the total.
      { id: "fits", model: "claude-opus-5-5", prompt: 200_000, cents: 100, toolCalls: tools([30, 20]) },
      // Not a 5.5 row: no old value, even with tools above the total.
      { id: "opus5", model: "claude-opus-5", prompt: 20_000, cents: 10, toolCalls: tools([8, 8]) },
    ]);
    expect(rawOf(db, "fits").before).toBe(100);
    expect(rawOf(db, "opus5").before).toBeNull();
    const was = [rawOf(db, "fits"), rawOf(db, "opus5")];

    db.exec(MIGRATION_SQL);
    expect([rawOf(db, "fits"), rawOf(db, "opus5")]).toEqual(was);
  });

  test("a second run changes nothing", () => {
    const db = repriced([sixOneCent("many"), {
      id: "odd", model: "claude-sonnet-5-5", prompt: 20_000, cents: 6, toolCalls: tools([1, 1, 1, 1, 1, 1, 1, 1, 1]),
    }]);
    db.exec(MIGRATION_SQL);
    const once = [rawOf(db, "many"), rawOf(db, "odd")];
    expect(toolSum(once[1]!.t!)).toBeLessThanOrEqual(once[1]!.cost);
    db.exec(MIGRATION_SQL);
    expect([rawOf(db, "many"), rawOf(db, "odd")]).toEqual(once);
  });
});
