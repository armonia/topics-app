/**
 * The 5.5 history, repriced: `20261024180000-reprice-5-5-history.sql`.
 *
 * Until 24/10/2026 every 5.5 row was billed at another model's price (Opus 5.5
 * as Opus 5, cache reads at 0.1x instead of 0.05x). The migration reprices the
 * rows whose stored cost IS the old table's price of their own tokens, keeps the
 * old value in a column, and marks the Haiku 5.5 rows it can only estimate.
 *
 * Runs the migration FILE, not a copy. The prices are written here as constants
 * from the official page: an expected value computed with the table under test
 * could not catch a wrong row.
 * @covers USAGE-01
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { PROJECT_ROOT } from "./helpers";

const MIGRATION_SQL = fs.readFileSync(
  path.join(PROJECT_ROOT, "server/db/migrations/20261024180000-reprice-5-5-history.sql"),
  "utf-8",
);

interface Row {
  id: string;
  model: string;
  prompt: number;
  completion: number;
  read: number | null;
  write5m?: number;
  write1h?: number;
  cents?: number;
  toolCalls?: unknown[];
  blocks?: unknown[];
}

/** Cents for `r` at input price `inp` ($/M), cache read `readRate`; output is 5x input on every row here. */
function priced(r: Row, inp: number, readRate: number): number {
  const read = r.read ?? 0, w5 = r.write5m ?? 0, w1h = r.write1h ?? 0;
  const fresh = Math.max(0, r.prompt - read - w5 - w1h);
  return ((fresh + read * readRate + w5 * 1.25 + w1h * 2 + r.completion * 5) * inp) / 10_000;
}

/** What the old table charged: Opus 5.5 as Opus 5, Sonnet 5.x at $3, Haiku 5.5 as Haiku 4.5, Fable 5.1 as Fable 5. */
const OLD_INPUT: Record<string, number> = {
  "claude-opus-5-5": 5, "claude-opus-5-5[1m]": 5, "claude-sonnet-5-5": 3, "claude-sonnet-5": 3,
  "claude-sonnet-5[1m]": 3, "claude-haiku-5-5": 1, "claude-fable-5-1": 10, "claude-opus-5": 5,
};

function seed(rows: Row[]): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, model TEXT, cost_cents INTEGER,
    usage_prompt_tokens INTEGER, usage_completion_tokens INTEGER,
    cache_read_tokens INTEGER, cache_creation_tokens INTEGER, cache_creation_1h_tokens INTEGER,
    tool_calls TEXT, blocks TEXT)`);
  const insert = db.prepare(`INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of rows) {
    insert.run(
      r.id, r.model, r.cents ?? Math.round(priced(r, OLD_INPUT[r.model]!, 0.1)),
      r.prompt, r.completion, r.read,
      r.read === null ? null : (r.write5m ?? 0), r.read === null ? null : (r.write1h ?? 0),
      r.toolCalls ? JSON.stringify(r.toolCalls) : null, r.blocks ? JSON.stringify(r.blocks) : null,
    );
  }
  return db;
}

/** The stored cost, readable before the migration adds its columns. */
const costOf = (db: Database, id: string): number =>
  (db.query("SELECT cost_cents c FROM messages WHERE id = ?").get(id) as { c: number }).c;

type Out = { cost: number; before: number | null; estimated: number | null };
const rowOf = (db: Database, id: string): Out =>
  db.query("SELECT cost_cents cost, cost_cents_before_reprice before, cost_estimated estimated FROM messages WHERE id = ?").get(id) as Out;

/** A cache-heavy turn, like a real one: 2M prompt, 1.9M of it re-read. */
const turn = (id: string, model: string, extra: Partial<Row> = {}): Row => ({
  id, model, prompt: 2_000_000, completion: 20_000, read: 1_900_000, write5m: 50_000, write1h: 20_000, ...extra,
});

describe("the 5.5 history is repriced from its own tokens", () => {
  test("each model at its official price, the old value kept beside it", () => {
    const rows = [
      turn("opus", "claude-opus-5-5"),
      turn("opus1m", "claude-opus-5-5[1m]"),
      turn("sonnet55", "claude-sonnet-5-5"),
      turn("sonnet5", "claude-sonnet-5"),
      turn("sonnet5w", "claude-sonnet-5[1m]"),
      turn("fable", "claude-fable-5-1"),
    ];
    const db = seed(rows);
    const before = Object.fromEntries(rows.map((r) => [r.id, costOf(db, r.id)]));
    db.exec(MIGRATION_SQL);

    const expected: Record<string, number> = {
      opus: priced(rows[0]!, 4, 0.05),
      opus1m: priced(rows[1]!, 4, 0.05),
      sonnet55: priced(rows[2]!, 2, 0.05),
      sonnet5: priced(rows[3]!, 2, 0.1),
      sonnet5w: priced(rows[4]!, 2, 0.1),
      fable: priced(rows[5]!, 10, 0.025),
    };
    for (const [id, cents] of Object.entries(expected)) {
      const out = rowOf(db, id);
      expect(out.cost, id).toBe(Math.round(cents));
      expect(out.before, id).toBe(before[id]!);
      expect(out.estimated, id).toBeNull();
    }
    // Opus 5.5 on a cache-heavy turn: 211 cents become 131.
    expect([before.opus, rowOf(db, "opus").cost]).toEqual([211, 131]);
  });

  test("Opus 5 keeps its price: same row, same cost, no old value", () => {
    const db = seed([turn("opus5", "claude-opus-5")]);
    const was = costOf(db, "opus5");
    db.exec(MIGRATION_SQL);
    expect(rowOf(db, "opus5")).toEqual({ cost: was, before: null, estimated: null });
  });

  test("a cost that is not the old table's price of its tokens is left alone", () => {
    // A provider's own figure, or a row already priced right.
    const db = seed([
      turn("provider", "claude-opus-5-5", { cents: 777 }),
      turn("already", "claude-opus-5-5", { cents: Math.round(priced(turn("x", "claude-opus-5-5"), 4, 0.05)) }),
    ]);
    db.exec(MIGRATION_SQL);
    expect(rowOf(db, "provider")).toEqual({ cost: 777, before: null, estimated: null });
    expect(rowOf(db, "already").before).toBeNull();
  });

  test("rows without the cache split are not touched", () => {
    const db = seed([turn("old", "claude-opus-5-5", { read: null, cents: 900 })]);
    db.exec(MIGRATION_SQL);
    expect(rowOf(db, "old")).toEqual({ cost: 900, before: null, estimated: null });
  });
});

describe("Haiku 5.5: exact under 100k, an upper-bound estimate over", () => {
  test("a turn of at most 100k tokens had every call on the cheap card: exact", () => {
    const r = turn("small", "claude-haiku-5-5", { prompt: 90_000, read: 80_000, write5m: 0, write1h: 0, completion: 2_000 });
    const db = seed([r]);
    db.exec(MIGRATION_SQL);
    expect(rowOf(db, "small").cost).toBe(Math.max(1, Math.round(priced(r, 0.1, 0.1))));
    expect(rowOf(db, "small").estimated).toBeNull();
  });

  test("over 100k: priced on the long card and marked estimated", () => {
    const r = turn("big", "claude-haiku-5-5");
    const db = seed([r]);
    const was = costOf(db, "big");
    db.exec(MIGRATION_SQL);
    expect(rowOf(db, "big")).toEqual({ cost: Math.round(priced(r, 0.5, 0.1)), before: was, estimated: 1 });
  });
});

describe("the per-tool costs follow the message", () => {
  test("scaled by the message's ratio, other fields and shapes kept", () => {
    const db = seed([turn("tool", "claude-opus-5-5", {
      toolCalls: [{ id: "t1", name: "Bash", costCents: 300, tokens: 100 }, { id: "t2", name: "Read" }],
      blocks: [{ kind: "tool", toolCall: { id: "t1", name: "Bash", costCents: 300 } }, { kind: "text", text: "ok" }],
    })]);
    db.exec(MIGRATION_SQL);
    const { cost, before } = rowOf(db, "tool");
    const scaled = Math.floor((300 * cost) / before!);
    const raw = (db.query("SELECT tool_calls t, blocks b FROM messages WHERE id = 'tool'").get() as { t: string; b: string });
    expect(raw.t.startsWith("[{")).toBe(true);
    const tc = JSON.parse(raw.t) as Array<Record<string, unknown>>;
    expect(tc[0]).toEqual({ id: "t1", name: "Bash", costCents: scaled, tokens: 100 });
    expect(tc[1]).toEqual({ id: "t2", name: "Read" });
    const bl = JSON.parse(raw.b) as Array<Record<string, unknown>>;
    expect((bl[0]!.toolCall as Record<string, unknown>).costCents).toBe(scaled);
    expect(bl[1]).toEqual({ kind: "text", text: "ok" });
  });

  test("scaled tool costs never add up to more than the message's new total", () => {
    // Six one-cent tools in a 6 cent Sonnet 5.5 turn, repriced to 4 cents: rounding each
    // tool up to a cent (or a floor of one) would make them add up to 6, above the total.
    const oneCent = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, name: "Read", costCents: 1 }));
    const db = seed([{ id: "many", model: "claude-sonnet-5-5", prompt: 20_000, completion: 0, read: 0, toolCalls: oneCent,
      blocks: oneCent.map((toolCall) => ({ kind: "tool", toolCall })) }]);
    db.exec(MIGRATION_SQL);
    const { cost, before } = rowOf(db, "many");
    expect(before).toBe(6);
    expect(cost).toBe(4);
    const raw = db.query("SELECT tool_calls t, blocks b FROM messages WHERE id = 'many'").get() as { t: string; b: string };
    const sum = (JSON.parse(raw.t) as Array<{ costCents: number }>).reduce((a, t) => a + t.costCents, 0);
    const blockSum = (JSON.parse(raw.b) as Array<{ toolCall: { costCents: number } }>).reduce((a, b) => a + b.toolCall.costCents, 0);
    expect(sum).toBeLessThanOrEqual(cost);
    expect(blockSum).toBeLessThanOrEqual(cost);
  });
});

describe("going back", () => {
  test("the statement in the migration's header restores every message cost", () => {
    const rows = [turn("a", "claude-opus-5-5"), turn("b", "claude-sonnet-5-5"), turn("c", "claude-haiku-5-5")];
    const db = seed(rows);
    const was = rows.map((r) => costOf(db, r.id));
    db.exec(MIGRATION_SQL);
    db.exec("UPDATE messages SET cost_cents = cost_cents_before_reprice, cost_estimated = NULL WHERE cost_cents_before_reprice IS NOT NULL");
    expect(rows.map((r) => rowOf(db, r.id).cost)).toEqual(was);
  });
});
