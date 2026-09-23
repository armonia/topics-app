/**
 * History cleanup: `20260923230000-mark-old-goal-nudges.sql`.
 *
 * Six goal continuations of 4-5 September were written without their mark and
 * are still drawn as the person saying «Objective still open: ...». The test
 * runs the migration FILE: what matters is what it leaves alone.
 * @covers CHAT-GOALLOOP-01
 */
import { describe, expect, test, beforeAll } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";
import { setupTestDataDir, createTestAppContext, PROJECT_ROOT, testTmpDir } from "./helpers";
import type { AppContext } from "../../server/types";

const TEST_DATA = testTmpDir("migration-old-goal-nudges");
const MIGRATION_SQL = fs.readFileSync(
  path.join(PROJECT_ROOT, "server/db/migrations/20260923230000-mark-old-goal-nudges.sql"),
  "utf-8",
);
const NUDGE = '[{"kind":"goal-nudge","attempt":1}]';

beforeAll(() => setupTestDataDir(TEST_DATA));

let seq = 0;
function insert(ctx: AppContext, rows: Array<{ id: string; role?: string; content: string; blocks?: string | null }>): void {
  const stmt = ctx.db.prepare(
    `INSERT INTO messages (id, session_key, role, content, blocks, timestamp, sort_order) VALUES (?, 'topic:old', ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) stmt.run(r.id, r.role ?? "user", r.content, r.blocks ?? null, new Date(Date.now() + ++seq * 1000).toISOString(), seq);
}
const blocksOf = (ctx: AppContext, id: string) =>
  (ctx.db.query(`SELECT blocks FROM messages WHERE id = ?`).get(id) as { blocks: string | null }).blocks;

describe("migration 20260923230000: the old goal continuations", () => {
  test("marks the unmarked continuation and nothing else", async () => {
    const ctx = await createTestAppContext();
    const already = '[{"kind":"goal-nudge","attempt":4}]';
    insert(ctx, [
      { id: "n1", content: "Objective still open: finish the gate. Continue." },
      { id: "n2", content: "Objective still open: x", blocks: already },
      { id: "q1", content: "why do I see «Objective still open: ...» in my chat?" },
      { id: "a1", role: "assistant", content: "Objective still open: I am on it." },
    ]);

    ctx.db.exec(MIGRATION_SQL);

    expect(blocksOf(ctx, "n1")).toBe(NUDGE);
    expect(blocksOf(ctx, "n2")).toBe(already);
    expect(blocksOf(ctx, "q1")).toBeNull();
    expect(blocksOf(ctx, "a1")).toBeNull();
  });
});
