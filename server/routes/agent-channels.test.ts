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

  test("one chat with a NULL thread and two threads gives three distinct titles", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-channels-"));
    try {
      const path = join(dir, "c.sqlite");
      const db = new Database(path);
      db.run("CREATE TABLE turns (id INTEGER PRIMARY KEY, chat TEXT, thread TEXT, meta TEXT)");
      db.run(`INSERT INTO turns (chat, thread, meta) VALUES
        ('7', NULL, '{"chat_title":"#main"}'), ('7', 'a', '{"chat_title":"#thread-a"}'), ('7', 'b', '{"chat_title":"#thread-b"}'), ('7', 'a', '{"chat_title":"#thread-a2"}')`);
      db.close();
      expect(readChannelTitles(path)).toEqual({ "7": "#main", "7:a": "#thread-a2", "7:b": "#thread-b" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
