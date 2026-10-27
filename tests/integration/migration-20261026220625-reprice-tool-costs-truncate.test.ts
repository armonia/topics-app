/**
 * The per-tool costs of the 5.5 reprice, back under the message total:
 * `20261026220625-reprice-tool-costs-truncate.sql` plus its step,
 * `truncateToolCostsToTotal` (server/db/migration-steps.ts).
 *
 * Every test starts from a DB that already ran `20261024180000-reprice-5-5-history.sql`,
 * like production since 24/10: that migration rounded each tool's scaled cost and
 * floored it at one cent, so many cheap tools could add up to more than the message.
 *
 * `blocks` is stored the way the server stores it: through `encodeCol`, so a
 * turn past 512 bytes is a zstd blob and `json_valid(blocks)` is 0 for it. The
 * first version of this migration was SQL only, passed against plain-JSON
 * fixtures and changed 0 rows on the live DB, where 1,898 of 2,065 repriced
 * rows are blobs. The fixtures below are blobs for that reason, and a test
 * pins that they really are.
 *
 * Runs the migration FILES and the real runner, not copies.
 * @covers USAGE-01
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { PROJECT_ROOT } from "./helpers";
import { decodeCol, encodeCol } from "../../shared/message-blob";
import { MIGRATION_STEPS } from "../../server/db/migration-steps";
import { closeDatabase, initDatabase } from "../../server/db";

const MIGRATION_NAME = "20261026220625-reprice-tool-costs-truncate.sql";
const read = (name: string): string =>
  fs.readFileSync(path.join(PROJECT_ROOT, "server/db/migrations", name), "utf-8");
const REPRICE_SQL = read("20261024180000-reprice-5-5-history.sql");
const MIGRATION_SQL = read(MIGRATION_NAME);

/** The migration as the runner applies it: its SQL, then its step. */
function migrate(db: Database): void {
  db.exec(MIGRATION_SQL);
  MIGRATION_STEPS[MIGRATION_NAME]!(db);
}

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
    // As the writers do: `tool_calls` is born in plain text, `blocks` goes
    // through the codec (a blob past 512 bytes).
    insert.run(r.id, r.model, r.cents, r.prompt,
      r.toolCalls ? JSON.stringify(r.toolCalls) : null,
      r.blocks ? (encodeCol(JSON.stringify(r.blocks)) ?? null) : null);
  }
  db.exec(REPRICE_SQL);
  return db;
}

/** What is in the row, byte for byte (`blocks` as stored: text or blob). */
interface Stored { cost: number; before: number | null; t: string | null; blocks: string | Uint8Array | null; valid: number | null }
const storedOf = (db: Database, id: string): Stored =>
  db.query(
    "SELECT cost_cents cost, cost_cents_before_reprice before, tool_calls t, blocks, json_valid(blocks) valid FROM messages WHERE id = ?",
  ).get(id) as Stored;

const blocksOf = (s: Stored): string => decodeCol(s.blocks)!;
const isBlob = (s: Stored): boolean => s.blocks instanceof Uint8Array;

const toolSum = (t: string): number =>
  (JSON.parse(t) as Array<{ costCents?: number }>).reduce((a, x) => a + (x.costCents ?? 0), 0);
const blockSum = (b: string): number =>
  (JSON.parse(b) as Array<{ toolCall?: { costCents?: number } }>).reduce((a, x) => a + (x.toolCall?.costCents ?? 0), 0);

const tools = (cents: number[]) => cents.map((costCents, i) => ({ id: `t${i}`, name: "Read", costCents }));
const toolBlocks = (cents: number[]) => tools(cents).map((toolCall) => ({ kind: "tool", toolCall }));

/** About 1 KB of turn text: enough to push `blocks` past the codec's 512 byte threshold. */
const BULK = { kind: "text", text: "a line of what the tool printed\n".repeat(40) };

/** Six one-cent tools in a 6 cent Sonnet 5.5 turn ($3 then): repriced to 4 cents ($2), the tools stay at 6. */
const sixOneCent = (id: string, withBulk = false): Row => ({
  id, model: "claude-sonnet-5-5", prompt: 20_000, cents: 6,
  toolCalls: tools([1, 1, 1, 1, 1, 1]),
  blocks: withBulk ? [...toolBlocks([1, 1, 1, 1, 1, 1]), BULK] : toolBlocks([1, 1, 1, 1, 1, 1]),
});

describe("the tools of a repriced message add up to at most its total", () => {
  test("six 1-cent tools in a turn repriced from 6 to 4 cents", () => {
    const db = repriced([sixOneCent("many")]);
    const was = storedOf(db, "many");
    expect([was.before, was.cost]).toEqual([6, 4]);
    expect(toolSum(was.t!)).toBe(6); // what the 24/10 reprice left in production

    migrate(db);
    const out = storedOf(db, "many");
    expect(out.cost).toBe(4);
    expect(toolSum(out.t!)).toBeLessThanOrEqual(4);
    expect(blockSum(blocksOf(out))).toBeLessThanOrEqual(4);
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
    expect(toolSum(storedOf(db, "mixed").t!)).toBe(4);
    db.exec("UPDATE messages SET cost_cents = 3 WHERE id = 'mixed'");

    migrate(db);
    const out = storedOf(db, "mixed");
    expect(out.t!.startsWith("[{")).toBe(true);
    // 2 * 3/4 = 1.5, truncated to 1.
    expect(JSON.parse(out.t!)).toEqual([
      { id: "a", name: "Bash", costCents: 1, tokens: 100 },
      { id: "b", name: "Read", costCents: 1 },
      { id: "c", name: "Grep" },
    ]);
    expect(JSON.parse(blocksOf(out))).toEqual([
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
    expect(storedOf(db, "fits").before).toBe(100);
    expect(storedOf(db, "opus5").before).toBeNull();
    const was = [storedOf(db, "fits"), storedOf(db, "opus5")];

    migrate(db);
    expect([storedOf(db, "fits"), storedOf(db, "opus5")]).toEqual(was);
  });

  test("a second run changes nothing", () => {
    const db = repriced([sixOneCent("many"), {
      id: "odd", model: "claude-sonnet-5-5", prompt: 20_000, cents: 6, toolCalls: tools([1, 1, 1, 1, 1, 1, 1, 1, 1]),
    }]);
    migrate(db);
    const once = [storedOf(db, "many"), storedOf(db, "odd")];
    expect(toolSum(once[1]!.t!)).toBeLessThanOrEqual(once[1]!.cost);
    migrate(db);
    expect([storedOf(db, "many"), storedOf(db, "odd")]).toEqual(once);
  });
});

describe("rows stored as production stores them: `blocks` as a zstd blob", () => {
  test("the fixture is a blob that SQL cannot read, and the reprice left its tools at 6 cents", () => {
    const db = repriced([sixOneCent("blob", true)]);
    const was = storedOf(db, "blob");
    expect(isBlob(was)).toBe(true);
    expect(was.valid).toBe(0); // what made the SQL-only version skip it
    expect(was.cost).toBe(4);
    expect(blockSum(blocksOf(was))).toBe(6); // the reprice's own UPDATE skipped it too
  });

  test("a blob over the total is brought under it, stays a blob, and keeps everything else", () => {
    const db = repriced([sixOneCent("blob", true)]);
    migrate(db);
    const out = storedOf(db, "blob");
    expect(isBlob(out)).toBe(true);
    expect(blockSum(blocksOf(out))).toBeLessThanOrEqual(4);
    expect(toolSum(out.t!)).toBeLessThanOrEqual(4); // the plain-text column of the same row, too
    const blocks = JSON.parse(blocksOf(out)) as Array<{ kind: string; toolCall?: { id: string; name: string; costCents: number } }>;
    // 1 * 4/6 = 0.67, truncated to 0, for each of the six.
    expect(blocks.filter((b) => b.kind === "tool").map((b) => b.toolCall!.costCents)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(blocks.at(-1)).toEqual(BULK);
    expect(blocks[0]!.toolCall).toEqual({ id: "t0", name: "Read", costCents: 0 });
  });

  test("text and blob rows together: each over-total row fixed, each fitting row byte-identical", () => {
    const db = repriced([
      sixOneCent("text"),
      sixOneCent("blob", true),
      // Repriced, tools under the total, as a blob: not written.
      { id: "fits", model: "claude-opus-5-5", prompt: 200_000, cents: 100, blocks: [...toolBlocks([30, 20]), BULK] },
      // Not repriced, tools over the total, as a blob: not this migration's.
      { id: "opus5", model: "claude-opus-5", prompt: 20_000, cents: 10, blocks: [...toolBlocks([8, 8]), BULK] },
    ]);
    expect([isBlob(storedOf(db, "text")), isBlob(storedOf(db, "blob")), isBlob(storedOf(db, "fits")), isBlob(storedOf(db, "opus5"))])
      .toEqual([false, true, true, true]);
    const untouched = [storedOf(db, "fits"), storedOf(db, "opus5")];

    migrate(db);
    for (const id of ["text", "blob"]) {
      const out = storedOf(db, id);
      expect(blockSum(blocksOf(out))).toBeLessThanOrEqual(out.cost);
    }
    expect([storedOf(db, "fits"), storedOf(db, "opus5")]).toEqual(untouched);
  });

  test("a second run changes nothing, byte for byte", () => {
    const db = repriced([sixOneCent("text"), sixOneCent("blob", true), {
      id: "odd", model: "claude-sonnet-5-5", prompt: 20_000, cents: 6,
      blocks: [...toolBlocks([1, 1, 1, 1, 1, 1, 1, 1, 1]), BULK],
    }]);
    migrate(db);
    const once = ["text", "blob", "odd"].map((id) => storedOf(db, id));
    expect(blockSum(blocksOf(once[2]!))).toBeLessThanOrEqual(once[2]!.cost);
    migrate(db);
    expect(["text", "blob", "odd"].map((id) => storedOf(db, id))).toEqual(once);
  });

  test("a blob that cannot be read is left alone and does not stop the migration", () => {
    const db = repriced([sixOneCent("good", true), sixOneCent("bad", true)]);
    db.run("UPDATE messages SET blocks = ? WHERE id = 'bad'", [new Uint8Array([1, 2, 3, 4])]);
    migrate(db);
    expect(blockSum(blocksOf(storedOf(db, "good")))).toBeLessThanOrEqual(4);
    expect(Array.from(storedOf(db, "bad").blocks as Uint8Array)).toEqual([1, 2, 3, 4]);
  });
});

describe("the migration runner applies the step", () => {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "reprice-truncate-"));
  afterAll(() => {
    try { closeDatabase(); } catch { /* already closed */ }
    rmSync(dataRoot, { recursive: true, force: true });
  });

  test("on a database that has every earlier migration and rows stored as blobs", () => {
    // 1. A database with every migration applied, then the fixtures of a live
    // one: repriced rows (an old value set), `blocks` through the server's own
    // encoder, and this migration forgotten, as if the server had not booted
    // since the code landed.
    const first = initDatabase(PROJECT_ROOT, dataRoot);
    const insert = first.prepare(
      `INSERT INTO messages (id, session_key, role, timestamp, cost_cents, cost_cents_before_reprice, tool_calls, blocks)
       VALUES (?, 's', 'assistant', '2026-10-24T10:00:00Z', ?, ?, ?, ?)`);
    const blocksOver = encodeCol(JSON.stringify([...toolBlocks([1, 1, 1, 1, 1, 1]), BULK]))!;
    insert.run("over", 4, 6, JSON.stringify(tools([1, 1, 1, 1, 1, 1])), blocksOver);
    insert.run("fits", 100, 120, null, encodeCol(JSON.stringify([...toolBlocks([30, 20]), BULK]))!);
    insert.run("old", 4, null, null, encodeCol(JSON.stringify([...toolBlocks([1, 1, 1, 1, 1, 1]), BULK]))!);
    first.run("DELETE FROM schema_migrations WHERE name = ?", [MIGRATION_NAME]);
    const fits = storedOf(first, "fits");
    const old = storedOf(first, "old");
    expect(blockSum(blocksOf(storedOf(first, "over")))).toBe(6);
    closeDatabase();

    // 2. The next boot applies it.
    const db = initDatabase(PROJECT_ROOT, dataRoot);
    const over = storedOf(db, "over");
    expect(isBlob(over)).toBe(true);
    expect(blockSum(blocksOf(over))).toBeLessThanOrEqual(4);
    expect(toolSum(over.t!)).toBeLessThanOrEqual(4);
    expect(storedOf(db, "fits")).toEqual(fits);
    expect(storedOf(db, "old")).toEqual(old);
    expect(db.query("SELECT name FROM schema_migrations WHERE name = ?").all(MIGRATION_NAME)).toHaveLength(1);
  });
});
