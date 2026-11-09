/**
 * The channel titles behind the Agents view's names.
 *
 * @covers TOPIC-02
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readChannelTitles } from "./agent-channels";

describe("readChannelTitles", () => {
  test("the last non-empty title per chat; a missing file is an empty map", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-channels-"));
    try {
      const path = join(dir, "c.sqlite");
      const db = new Database(path);
      db.run("CREATE TABLE turns (id INTEGER PRIMARY KEY, chat TEXT, meta TEXT)");
      db.run(`INSERT INTO turns (chat, meta) VALUES ('1', '{"chat_title":"#old"}'), ('1', '{"chat_title":"#new"}'), ('1', '{"chat_title":""}'), ('2', '{}')`);
      db.close();
      expect(readChannelTitles(path)).toEqual({ "1": "#new" });
      expect(readChannelTitles(join(dir, "none.sqlite"))).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("one chat, a bare turn and two threads give three distinct titles", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-channels-"));
    try {
      const path = join(dir, "c.sqlite");
      const db = new Database(path);
      db.run("CREATE TABLE turns (id INTEGER PRIMARY KEY, chat TEXT, thread TEXT, meta TEXT)");
      db.run(`INSERT INTO turns (chat, thread, meta) VALUES
        ('9', NULL, '{"chat_title":"#main"}'),
        ('9', 't1', '{"chat_title":"#main > one"}'),
        ('9', 't2', '{"chat_title":"#main > two"}')`);
      db.close();
      const titles = readChannelTitles(path);
      expect(titles["9:t1"]).toBe("#main > one");
      expect(titles["9:t2"]).toBe("#main > two");
      expect(new Set([titles["9"], titles["9:t1"], titles["9:t2"]]).size).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
