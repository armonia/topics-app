/**
 * Per-project consumption: chats and board work must land on ONE row, and the
 * money must say out loud that it is partial.
 *
 * Runs on a real SQLite with the real column names, because the two failures
 * being pinned are both invisible to a mock: a key that does not normalise
 * silently splits a project in two, and a cost that omits the agents silently
 * looks complete.
 *
 * @covers USAGE-05
 * @covers USAGE-24
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { projectIdForPath } from "../../shared/board";
import { projectUsage } from "./project-usage";

const ALPHA = "/Users/x/Projects/alpha";
const BETA = "/Users/x/Projects/beta";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY, session_key TEXT UNIQUE, project_path TEXT)`);
  db.run(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, session_key TEXT, timestamp TEXT,
    usage_prompt_tokens INTEGER, usage_completion_tokens INTEGER,
    cache_read_tokens INTEGER, cost_cents INTEGER, cost_estimated INTEGER)`);
  db.run(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, project_id TEXT, completed_at TEXT, updated_at TEXT,
    agent_tokens INTEGER, agent_cache_read_tokens INTEGER)`);
  // The table as the side-call migration rebuilds it.
  db.run(`CREATE TABLE usage_records (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), timestamp INTEGER NOT NULL,
    session_key TEXT NOT NULL, topic_id TEXT, model TEXT NOT NULL,
    input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, cost_usd REAL,
    purpose TEXT, provider TEXT, cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
    cache_creation_1h_tokens INTEGER, duration_ms INTEGER, measured INTEGER NOT NULL DEFAULT 1, error TEXT)`);
  return db;
}

let seq = 0;
function topic(db: Database, key: string, path: string | null) {
  db.prepare(`INSERT INTO topics VALUES (?, ?, ?)`).run(`t${seq++}`, key, path);
}
function message(
  db: Database,
  key: string,
  o: { prompt?: number; completion?: number; cacheRead?: number | null; cents?: number; at?: string; estimated?: boolean },
) {
  db.prepare(`INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    `m${seq++}`, key, o.at ?? new Date().toISOString(),
    o.prompt ?? 0, o.completion ?? 0,
    o.cacheRead === undefined ? 0 : o.cacheRead, o.cents ?? 0, o.estimated ? 1 : null,
  );
}
function task(db: Database, projectId: string, tokens: number, cacheRead = 0, at?: string) {
  const when = at ?? new Date().toISOString();
  db.prepare(`INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?)`).run(
    `k${seq++}`, projectId, when, when, tokens, cacheRead,
  );
}

describe("projectUsage", () => {
  test("a chat and a board card on the SAME folder produce ONE row", () => {
    // THE TRAP. `topics.project_path` is a path and `tasks.project_id` is the
    // hashed board id: summed side by side they are two rows with the same
    // name, and each of them is individually correct — which is why nothing
    // downstream would flag it.
    const db = makeDb();
    topic(db, "topic:aaaa", ALPHA);
    message(db, "topic:aaaa", { prompt: 1_000, completion: 500, cacheRead: 0 });
    task(db, projectIdForPath(ALPHA), 2_000);

    const out = projectUsage(db);
    expect(out.projects).toHaveLength(1);
    const row = out.projects[0];
    expect(row.projectId).toBe(projectIdForPath(ALPHA));
    expect(row.projectPath).toBe(ALPHA);
    expect(row.chatTokens).toBe(1_500);
    expect(row.taskTokens).toBe(2_000);
    expect(row.totalTokens).toBe(3_500);
  });

  test("two folders sharing a basename stay two projects", () => {
    // The id is basename + hash of the WHOLE path, so `.../a/site` and
    // `.../b/site` are different projects. Cutting the key down to the folder
    // name would merge two clients' bills into one.
    const db = makeDb();
    topic(db, "topic:aaaa", "/Users/x/one/site");
    topic(db, "topic:bbbb", "/Users/x/two/site");
    message(db, "topic:aaaa", { prompt: 100, cacheRead: 0 });
    message(db, "topic:bbbb", { prompt: 200, cacheRead: 0 });
    expect(projectUsage(db).projects).toHaveLength(2);
  });

  test("board work with no chat still shows up, with a null path", () => {
    // `tasks` stores the id, not the path: the path is genuinely unrecoverable
    // here. `null` says so; omitting the project entirely would lose the
    // tokens, and inventing a path would be worse than both.
    const db = makeDb();
    task(db, "dancerooms-intq6i", 5_000);
    const out = projectUsage(db);
    expect(out.projects).toHaveLength(1);
    expect(out.projects[0].projectPath).toBeNull();
    expect(out.projects[0].taskTokens).toBe(5_000);
  });

  test("the dollar total declares itself partial when agents did the work", () => {
    // `tasks.agent_tokens` has no input/output split, so it cannot be priced —
    // and a payload that just shows a smaller number says nothing about why.
    const db = makeDb();
    topic(db, "topic:aaaa", ALPHA);
    message(db, "topic:aaaa", { prompt: 1_000, cacheRead: 0, cents: 250 });
    task(db, projectIdForPath(ALPHA), 9_000);

    const out = projectUsage(db);
    expect(out.totals.costUsd).toBe(2.5);
    expect(out.cost.partial).toBe(true);
    expect(out.cost.excluded.taskTokens).toBe(9_000);
  });

  test("a pre-cache-split row is excluded from the money AND counted as excluded", () => {
    // Its `cost_cents` billed re-read tokens as fresh input, inflated by a
    // factor nobody can recover. Adding it would produce a number that is
    // neither the real cost nor an estimate of it.
    const db = makeDb();
    topic(db, "topic:aaaa", ALPHA);
    message(db, "topic:aaaa", { prompt: 1_000, cacheRead: 0, cents: 100 });
    message(db, "topic:aaaa", { prompt: 1_000, cacheRead: null, cents: 5_000 });

    const out = projectUsage(db);
    expect(out.totals.costUsd).toBe(1);
    expect(out.projects[0].unpricedMessages).toBe(1);
    expect(out.cost.partial).toBe(true);
    expect(out.cost.excluded.messages).toBe(1);
  });

  test("an unpriced model makes the total partial even with nothing else missing", () => {
    // A model absent from the price table bills at zero, which is
    // indistinguishable from "it was free" unless something says it.
    const db = makeDb();
    topic(db, "topic:aaaa", ALPHA);
    message(db, "topic:aaaa", { prompt: 10, cacheRead: 0, cents: 5 });
    const out = projectUsage(db, { unpricedModels: ["claude-something-6"] });
    expect(out.cost.partial).toBe(true);
    expect(out.cost.excluded.models).toEqual(["claude-something-6"]);
  });

  test("an estimated cost stays in the total and is said apart, per row and overall", () => {
    // Haiku 5.5 turns over 100k tokens, repriced after the fact without their
    // calls: an upper bound. Leaving them out would understate the bill; adding
    // them silently would present a ceiling as a measure.
    const db = makeDb();
    topic(db, "topic:aaaa", ALPHA);
    message(db, "topic:aaaa", { prompt: 500_000, cacheRead: 0, cents: 120, estimated: true });
    message(db, "topic:aaaa", { prompt: 1_000, cacheRead: 0, cents: 30 });
    const out = projectUsage(db);
    expect(out.totals.costUsd).toBe(1.5);
    expect(out.projects[0].estimatedMessages).toBe(1);
    expect(out.cost.estimated).toEqual({ messages: 1, usd: 1.2 });
    expect(out.cost.partial).toBe(false);
  });

  test("a fully priced chat-only window is NOT flagged partial", () => {
    // The flag has to be able to be false, or it stops carrying information.
    const db = makeDb();
    topic(db, "topic:aaaa", ALPHA);
    message(db, "topic:aaaa", { prompt: 10, cacheRead: 0, cents: 5 });
    const out = projectUsage(db);
    expect(out.cost.partial).toBe(false);
    expect(out.totals.costUsd).toBe(0.05);
  });

  test("the window cuts by date on BOTH tables", () => {
    const db = makeDb();
    topic(db, "topic:aaaa", ALPHA);
    message(db, "topic:aaaa", { prompt: 100, cacheRead: 0, at: "2020-01-01T00:00:00.000Z" });
    message(db, "topic:aaaa", { prompt: 700, cacheRead: 0 });
    task(db, projectIdForPath(ALPHA), 4_000, 0, "2020-01-01T00:00:00.000Z");
    task(db, projectIdForPath(ALPHA), 11, 0);

    const all = projectUsage(db).projects[0];
    expect(all.chatTokens).toBe(800);
    expect(all.taskTokens).toBe(4_011);

    const week = projectUsage(db, { days: 7 }).projects[0];
    expect(week.chatTokens).toBe(700);
    expect(week.taskTokens).toBe(11);
  });

  test("a chat with no project is not a project", () => {
    // A scratch topic is not an unnamed project, and an empty-string key would
    // become one — a row that collects everything nobody filed.
    const db = makeDb();
    topic(db, "topic:aaaa", null);
    topic(db, "topic:bbbb", "");
    message(db, "topic:aaaa", { prompt: 100, cacheRead: 0 });
    message(db, "topic:bbbb", { prompt: 100, cacheRead: 0 });
    expect(projectUsage(db).projects).toHaveLength(0);
  });

  test("rows come back heaviest first, and the totals match the rows", () => {
    const db = makeDb();
    topic(db, "topic:aaaa", ALPHA);
    topic(db, "topic:bbbb", BETA);
    message(db, "topic:aaaa", { prompt: 100, cacheRead: 0 });
    message(db, "topic:bbbb", { prompt: 900, cacheRead: 0 });
    const out = projectUsage(db);
    expect(out.projects.map((p) => p.projectPath)).toEqual([BETA, ALPHA]);
    expect(out.totals.totalTokens).toBe(
      out.projects.reduce((a, p) => a + p.totalTokens, 0),
    );
  });

  test("cache re-reads are weighted, not counted as fresh input", () => {
    // The formula is the shared one (`usage/token-sql.ts`): a re-read is worth
    // a tenth. Re-deriving it here would be the copy that drifts.
    const db = makeDb();
    topic(db, "topic:aaaa", ALPHA);
    message(db, "topic:aaaa", { prompt: 200_000, completion: 5_000, cacheRead: 180_000 });
    // (200k - 180k) + 5k + 0.1 * 180k
    expect(projectUsage(db).projects[0].chatTokens).toBe(20_000 + 5_000 + 18_000);
  });

  test("side calls: counted by purpose, inside the window only, never in a project", () => {
    const db = makeDb();
    topic(db, "chat:a", ALPHA);
    message(db, "chat:a", { prompt: 100, completion: 10, cents: 50 });
    const now = Date.now();
    const old = now - 40 * 86_400_000;
    const side = db.prepare(`INSERT INTO usage_records (timestamp, session_key, model, total_tokens, cost_usd, purpose, measured, error)
      VALUES (?, 'side-call', 'claude-sonnet-5-5', ?, ?, ?, ?, ?)`);
    side.run(now, 1000, 0.08, "card-title", 1, null);
    side.run(now, 1000, 0.07, "card-title", 1, null);
    side.run(now, 500, 0.01, null, 1, null);
    // A provider that reported nothing (ACP): a call, not a free one.
    side.run(now, null, null, "chat-name", 0, null);
    // A Codex call measured on a model without a price.
    side.run(now, 300, null, "goal-judge", 1, null);
    // A CLI that timed out.
    side.run(now, null, null, "card-title", 0, "Completion timed out");
    side.run(old, 9999, 5, "card-title", 1, null);

    const month = projectUsage(db, { days: 30 });
    expect(month.sideCalls).toEqual({
      calls: 6,
      unmeasured: 2,
      unpriced: 1,
      failed: 1,
      costUsd: 0.16,
      byPurpose: [
        { purpose: "card-title", calls: 3, unmeasured: 1, costUsd: 0.15, tokens: 2000 },
        { purpose: "other", calls: 1, unmeasured: 0, costUsd: 0.01, tokens: 500 },
        { purpose: "chat-name", calls: 1, unmeasured: 1, costUsd: 0, tokens: 0 },
        { purpose: "goal-judge", calls: 1, unmeasured: 0, costUsd: 0, tokens: 300 },
      ],
    });
    // The project total is the chat alone.
    expect(month.totals.costUsd).toBe(0.5);

    const all = projectUsage(db);
    expect(all.sideCalls.calls).toBe(7);
  });

  test("a side call that answered a chat counts in that chat's project, not outside", () => {
    // The fallback reply of a provider without streaming: its message row has
    // no cost, the ledger row carries it.
    const db = makeDb();
    topic(db, "chat:a", ALPHA);
    message(db, "chat:a", { prompt: 100, completion: 10, cents: 50 });
    const topicId = (db.query(`SELECT id FROM topics WHERE session_key = 'chat:a'`).get() as { id: string }).id;
    db.prepare(`INSERT INTO usage_records (timestamp, session_key, topic_id, model, input_tokens, output_tokens, total_tokens,
      cost_usd, cache_read_tokens, purpose) VALUES (?, 'chat:a', ?, 'claude-sonnet-5-5', 1000, 100, 1100, 0.3, 0, 'chat-reply')`)
      .run(Date.now(), topicId);

    const out = projectUsage(db, { days: 30 });
    expect(out.sideCalls.calls).toBe(0);
    expect(out.projects[0]).toMatchObject({ projectPath: ALPHA, costUsd: 0.8 });
    expect(out.projects[0]!.chatTokens).toBe(100 + 10 + 1000 + 100);
  });

  const reply = (db: Database, key: string, o: { cost: number | null; measured: 0 | 1 }) => {
    const topicId = (db.query(`SELECT id FROM topics WHERE session_key = ?`).get(key) as { id: string }).id;
    db.prepare(`INSERT INTO usage_records (timestamp, session_key, topic_id, model, input_tokens, output_tokens, total_tokens,
      cost_usd, purpose, measured) VALUES (?, ?, ?, 'x', ?, ?, ?, ?, 'chat-reply', ?)`)
      .run(Date.now(), key, topicId, o.measured ? 1000 : null, o.measured ? 100 : null, o.measured ? 1100 : null, o.cost, o.measured);
  };

  test("a reply to a chat without a project is a service call, not lost from both totals", () => {
    const db = makeDb();
    topic(db, "chat:loose", null);
    reply(db, "chat:loose", { cost: 0.3, measured: 1 });
    const out = projectUsage(db, { days: 30 });
    expect(out.projects).toHaveLength(0);
    expect(out.sideCalls).toMatchObject({ calls: 1, costUsd: 0.3 });
  });

  test("an unmeasured reply inside a project is said apart, never a free one", () => {
    const db = makeDb();
    topic(db, "chat:acp", ALPHA);
    message(db, "chat:acp", { prompt: 100, completion: 10, cents: 50 });
    reply(db, "chat:acp", { cost: null, measured: 0 });
    const out = projectUsage(db, { days: 30 });
    expect(out.projects[0]).toMatchObject({ projectPath: ALPHA, costUsd: 0.5, unpricedMessages: 1 });
    expect(out.cost.partial).toBe(true);
    expect(out.cost.excluded.messages).toBe(1);
  });
});
