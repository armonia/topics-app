/** @covers KANBAN-01, AGENTS-NAV-01 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readChannelPlaces, readChannelPlacesById } from "./channel-place";

describe("readChannelPlaces", () => {
  test("a thread resolves to server, parent channel and its own title", () => {
    const dir = mkdtempSync(join(tmpdir(), "place-"));
    const path = join(dir, "c.sqlite");
    const db = new Database(path);
    db.run("CREATE TABLE turns (id INTEGER PRIMARY KEY, chat TEXT, thread TEXT, meta TEXT)");
    db.run("CREATE TABLE threads (chat TEXT, thread TEXT, title TEXT)");
    db.run(`INSERT INTO turns (chat, thread, meta) VALUES ('c1', NULL, '{"chat_title":"#zeno","guild_title":"Armonia"}')`);
    db.run(`INSERT INTO threads VALUES ('c1', 't1', 'Video musica')`);
    db.close();
    const places = readChannelPlaces(path);
    expect(places.get("zeno")).toEqual({ server: "Armonia", channel: "zeno" });
    expect(places.get("video musica")).toEqual({ server: "Armonia", channel: "zeno", thread: "Video musica" });
    rmSync(dir, { recursive: true });
  });
  test("no database is an empty map", () => {
    expect(readChannelPlaces("/nonexistent/x.sqlite").size).toBe(0);
  });
});

describe("readChannelPlacesById", () => {
  test("keys by the raw chat/thread id, not by title, for the Agents channel tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "place-"));
    const path = join(dir, "c.sqlite");
    const db = new Database(path);
    db.run("CREATE TABLE turns (id INTEGER PRIMARY KEY, chat TEXT, thread TEXT, meta TEXT)");
    db.run("CREATE TABLE threads (chat TEXT, thread TEXT, title TEXT)");
    db.run(`INSERT INTO turns (chat, thread, meta) VALUES ('c1', NULL, '{"chat_title":"#zeno","guild_title":"Armonia"}')`);
    db.run(`INSERT INTO threads VALUES ('c1', 't1', 'Video musica')`);
    db.close();
    const places = readChannelPlacesById(path);
    expect(places.c1).toEqual({ server: "Armonia" });
    expect(places["c1:t1"]).toEqual({ server: "Armonia", channel: "zeno", thread: "Video musica" });
    rmSync(dir, { recursive: true });
  });
  test("no database is an empty object", () => {
    expect(readChannelPlacesById("/nonexistent/x.sqlite")).toEqual({});
  });
});
