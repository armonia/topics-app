/**
 * A result owed to a parent chat for 15 minutes is delivered again (card 0f8f8b9b).
 * @covers SUBAGENT-14
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resetStaleSweep, sweepStaleResults } from "./subagent-stale-sweep";

const DIR = resolve(import.meta.dir, "../db/migrations");
const SQL = readdirSync(DIR).filter((f) => /subagent/.test(f)).sort().map((f) => readFileSync(resolve(DIR, f), "utf8")).join("\n");
const T0 = 1_000_000;
const pending = JSON.stringify([{ agentId: "c1", turn: 1, status: "completed", partial: false, text: "x", name: "n" }]);

describe("sweepStaleResults", () => {
  beforeEach(() => resetStaleSweep());
  test("asks again only after the result has been owed for 15 minutes", () => {
    const db = new Database(":memory:");
    db.exec(SQL);
    db.run("INSERT INTO subagents (id, parent_session_key, name, cwd, created_at, state, pending_results) VALUES ('c1', 'topic:t', 'n', '/p', 'now', 'retired', ?)", [pending]);
    const asked: string[] = [];
    const deliver = (r: { agentId: string }, _c: number | null, parent: string) => asked.push(`${r.agentId}>${parent}`);
    expect(sweepStaleResults(db as never, deliver as never, T0)).toBe(0);
    expect(sweepStaleResults(db as never, deliver as never, T0 + 14 * 60_000)).toBe(0);
    expect(sweepStaleResults(db as never, deliver as never, T0 + 16 * 60_000)).toBe(1);
    expect(asked).toEqual(["c1>topic:t"]);
  });
});
