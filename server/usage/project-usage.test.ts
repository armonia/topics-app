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
    cache_read_tokens INTEGER, cost_cents INTEGER)`);
  db.run(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, project_id TEXT, completed_at TEXT, updated_at TEXT,
    agent_tokens INTEGER, agent_cache_read_tokens INTEGER)`);
  return db;
}

let seq = 0;
function topic(db: Database, key: string, path: string | null) {
  db.prepare(`INSERT INTO topics VALUES (?, ?, ?)`).run(`t${seq++}`, key, path);
}
function message(
  db: Database,
  key: string,
  o: { prompt?: number; completion?: number; cacheRead?: number | null; cents?: number; at?: string },
) {
  db.prepare(`INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    `m${seq++}`, key, o.at ?? new Date().toISOString(),
    o.prompt ?? 0, o.completion ?? 0,
    o.cacheRead === undefined ? 0 : o.cacheRead, o.cents ?? 0,
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
});
