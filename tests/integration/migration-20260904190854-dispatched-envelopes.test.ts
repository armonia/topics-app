/**
 * History cleanup: `20260904190854-mark-dispatched-envelopes.sql`.
 *
 * Since `server/lib/user-row-marks.ts` exists the dispatcher's envelopes are
 * marked as they are written, but 2,301 rows written before it reached the
 * table with a NULL `blocks` and are rendered as words a person typed. The
 * migration marks them.
 *
 * What matters here is not what it MARKS, it is what it LEAVES ALONE: a human
 * message that quotes an opening halfway through a sentence stays NULL, and a
 * row that already carries marks keeps exactly the ones it has. So the test
 * runs the migration FILE, not a copy of it: if the predicate ever loosens,
 * it loosens under these cases.
 * @covers CHAT-ENV-01
 */
import { describe, expect, test, beforeAll } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";
import { setupTestDataDir, createTestAppContext, PROJECT_ROOT, testTmpDir } from "./helpers";
import type { AppContext } from "../../server/types";

const TEST_DATA = testTmpDir("migration-envelopes-data");

const MIGRATION_SQL = fs.readFileSync(
  path.join(PROJECT_ROOT, "server/db/migrations/20260904190854-mark-dispatched-envelopes.sql"),
  "utf-8",
);

const ENVELOPE = '[{"kind":"dispatched-envelope"}]';

beforeAll(() => setupTestDataDir(TEST_DATA));

type Row = { id: string; role?: "user" | "assistant"; content: string; blocks?: string | null };

let seq = 0;

/** Raw rows: the shapes under test are ones the API would not produce today. */
function insert(ctx: AppContext, sessionKey: string, rows: Row[]): void {
  const stmt = ctx.db.prepare(
    `INSERT INTO messages (id, session_key, role, content, blocks, timestamp, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    stmt.run(
      r.id,
      sessionKey,
      r.role ?? "user",
      r.content,
      r.blocks ?? null,
      new Date(Date.now() + seq++ * 1000).toISOString(),
      seq,
    );
  }
}

const blocksOf = (ctx: AppContext, id: string) =>
  (ctx.db.query(`SELECT blocks FROM messages WHERE id = ?`).get(id) as { blocks: string | null }).blocks;

describe("migration 20260904190854 — the envelopes nobody typed", () => {
  test("the four openings get the envelope mark", async () => {
    const ctx = await createTestAppContext();
    insert(ctx, "topic:four", [
      { id: "e1", content: "You are the exclusive owner of task 42bbed57 on this board." },
      { id: "e2", content: "Human update on task 42bbed57: land it." },
      { id: "e3", content: "Your previous turn on this task was interrupted. Resume." },
      { id: "e4", content: "LAST TURN on this task: deliver what you have." },
    ]);

    ctx.db.exec(MIGRATION_SQL);

    for (const id of ["e1", "e2", "e3", "e4"]) expect(blocksOf(ctx, id)).toBe(ENVELOPE);
  });

  test("a person QUOTING an opening mid sentence is left alone", async () => {
    const ctx = await createTestAppContext();
    insert(ctx, "topic:quote", [
      { id: "q1", content: "the board writes \"Human update on task\" and I never see it" },
      { id: "q2", content: "why does LAST TURN on a card fire twice?" },
    ]);

    ctx.db.exec(MIGRATION_SQL);

    expect(blocksOf(ctx, "q1")).toBeNull();
    expect(blocksOf(ctx, "q2")).toBeNull();
  });

  test("a row that already carries marks keeps the ones it has", async () => {
    const ctx = await createTestAppContext();
    const goalAndEnvelope = '[{"kind":"goal-nudge","attempt":3},{"kind":"dispatched-envelope"}]';
    insert(ctx, "topic:marked", [
      { id: "m1", content: "You are the exclusive owner of task 1 on this board.", blocks: goalAndEnvelope },
    ]);

    ctx.db.exec(MIGRATION_SQL);

    expect(blocksOf(ctx, "m1")).toBe(goalAndEnvelope);
  });

  test("an assistant row that opens the same way is prose, not an envelope", async () => {
    const ctx = await createTestAppContext();
    insert(ctx, "topic:assistant", [
      { id: "a1", role: "assistant", content: "You are the exclusive owner of task 7, so you decide." },
    ]);

    ctx.db.exec(MIGRATION_SQL);

    expect(blocksOf(ctx, "a1")).toBeNull();
  });
});
