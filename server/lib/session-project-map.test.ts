/**
 * The session-to-project bridge, on a real SQLite.
 *
 * @covers RES-ATTR-01
 */
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { resolveSessionProjects } from "./session-project-map";

function makeDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE topics (id TEXT PRIMARY KEY, session_key TEXT, project_path TEXT)`);
  const ins = db.prepare(`INSERT INTO topics (id, session_key, project_path) VALUES (?, ?, ?)`);
  ins.run("06519a5d-6c7c-4fb1-b310-98b4c0b05e6e", "topic:06519a5d", "/Users/x/Projects/alpha");
  ins.run("c8a6bf29-b6a1-43bc-bd1b-2e796f246d63", "topic:c8a6bf29", null);
  return db;
}

describe("resolveSessionProjects", () => {
  it("answers a chat by its session key and a terminal by its topic uuid", () => {
    // The two producers address the same row differently: a terminal carries
    // the full uuid, a chat the truncated `topic:` key. Making the caller
    // convert between the two is how the two halves drift apart.
    const map = resolveSessionProjects(makeDb(), [
      "topic:06519a5d",
      "c8a6bf29-b6a1-43bc-bd1b-2e796f246d63",
    ]);
    expect(map.get("topic:06519a5d")?.projectPath).toBe("/Users/x/Projects/alpha");
    expect(map.get("topic:06519a5d")?.topicId).toBe("06519a5d-6c7c-4fb1-b310-98b4c0b05e6e");
    // A topic with no project is FOUND, and simply has no path: "found without
    // a project" and "not found" are two different answers.
    const chat = map.get("c8a6bf29-b6a1-43bc-bd1b-2e796f246d63");
    expect(chat?.topicId).toBe("c8a6bf29-b6a1-43bc-bd1b-2e796f246d63");
    expect(chat?.projectPath).toBeUndefined();
  });

  it("leaves an unknown key out of the map instead of inventing a row", () => {
    const map = resolveSessionProjects(makeDb(), ["topic:deadbeef"]);
    expect(map.has("topic:deadbeef")).toBe(false);
  });

  it("runs no statement at all for an empty batch", () => {
    // The fleet sampler calls this on every reading; with no live session the
    // honest cost is zero, not "one query that returns nothing".
    const db = new Database(":memory:"); // no `topics` table on purpose
    expect(resolveSessionProjects(db, []).size).toBe(0);
    expect(resolveSessionProjects(db, ["", ""]).size).toBe(0);
  });

  it("survives a database that cannot answer, without taking the caller down", () => {
    // Attribution is a decoration on a measurement. A missing table must cost
    // the project name, never the memory figure it was decorating.
    const db = new Database(":memory:");
    expect(resolveSessionProjects(db, ["topic:06519a5d"]).size).toBe(0);
  });

  it("asks once for the whole batch, not once per session", () => {
    // The property, measured rather than asserted by reading the source: a
    // per-session loop would show up as N prepares.
    const db = makeDb();
    let prepares = 0;
    const real = db.prepare.bind(db);
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      prepares++;
      return real(sql);
    }) as typeof db.prepare;
    resolveSessionProjects(db, [
      "topic:06519a5d",
      "c8a6bf29-b6a1-43bc-bd1b-2e796f246d63",
      "topic:deadbeef",
    ]);
    expect(prepares).toBe(1);
  });
});
