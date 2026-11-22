/**
 * @covers AGENTS-NAV-01
 */
import { describe, test, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readAgentActivity, readAgentTurns } from "./agent-activity";

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

const NOW = 10 * 86_400_000;

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-activity-"));
  dirs.push(dir);
  const path = join(dir, "channels.sqlite");
  const db = new Database(path);
  db.run("CREATE TABLE turns (id INTEGER PRIMARY KEY, chat TEXT, channel TEXT, status TEXT, created INTEGER, meta TEXT)");
  const add = (agent: string, channel: string, status: string, created: number, error?: string) =>
    db.run("INSERT INTO turns (chat, channel, status, created, meta) VALUES ('1', ?, ?, ?, ?)", [channel, status, created, JSON.stringify({ agent, error })]);
  add("main", "discord", "done", NOW - 1000);
  add("main", "discord", "failed", NOW - 2000, "boom");
  add("main", "discord", "quota", NOW - 3000);
  add("main", "discord", "unito", NOW - 4000);
  add("gtm", "discord:visione", "done", NOW - 5000);
  add("main", "discord", "done", NOW - 8 * 86_400_000); // outside the window
  db.close();
  return path;
}

describe("readAgentActivity", () => {
  test("counts handled, failed, quota and merged per agent and channel, last 7 days only", () => {
    const rows = readAgentActivity(fixture(), 7, NOW);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ agent: "main", channel: "discord", handled: 4, failed: 1, quota: 1, merged: 1 });
    expect(rows[1]).toMatchObject({ agent: "gtm", channel: "discord:visione", handled: 1, failed: 0 });
  });

  test("a database that is missing gives no rows", () => {
    expect(readAgentActivity(join(tmpdir(), "nowhere.sqlite"), 7, NOW)).toEqual([]);
  });
});

describe("readAgentTurns", () => {
  test("lists the newest turns first with title and state, pending being at work", () => {
    const path = fixture();
    const db = new Database(path);
    db.run("INSERT INTO turns (chat, channel, status, created, meta) VALUES ('9', 'discord', 'pending', ?, ?)", [NOW - 500, JSON.stringify({ agent: "gtm", chat_title: "#outreach" })]);
    db.close();
    const turns = readAgentTurns(path, 7, NOW);
    expect(turns[0]).toMatchObject({ agent: "gtm", chat: "9", title: "#outreach", state: "working" });
    expect(turns.find((t) => t.error === "boom")).toMatchObject({ state: "failed" });
    expect(turns.every((t) => t.created >= NOW - 7 * 86_400_000)).toBe(true);
  });
});
