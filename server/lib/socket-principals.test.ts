/** WebSocket frames use the current owner and share grants. @covers GUEST-04, GUEST-06 */
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hashToken } from "./device-auth";
import { principalsRev, resolvePrincipals } from "./principals";
import { socketMayReceiveFrame } from "./socket-principals";
import type { WSData } from "../types";
import { TASKS_DDL } from "../db/test-schema";

const ROOT = join(import.meta.dir, "..", "..");

function database(): Database {
  const db = new Database(":memory:");
  db.run(TASKS_DDL);
  db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT)");
  for (const migration of ["080-devices.sql", "082-task-shares.sql", "083-grants.sql", "084-people-orgs.sql"]) {
    db.run(readFileSync(join(ROOT, "server", "db", "migrations", migration), "utf8"));
  }
  return db;
}

describe("principali delle socket WebSocket", () => {
  it("il frame successivo usa i diritti aggiornati dopo la revoca della proprietà", () => {
    const db = database();
    db.query("INSERT INTO people (id, display_name, created_at, origin, rev, updated_at) VALUES ('p1','Owner',1,'local',1,1)").run();
    db.query("DELETE FROM installation_owners WHERE is_default = 1").run();
    db.query("INSERT INTO installation_owners (person_id, added_at, is_default) VALUES ('p1',1,1)").run();
    db.query("INSERT INTO devices (id, name, token_hash, created_at, person_id) VALUES ('d1','Phone',?,1,'p1')")
      .run(hashToken("token"));
    db.query("INSERT INTO topics (id, name) VALUES ('private-topic','Private')").run();

    const initial = resolvePrincipals(db, "d1");
    const socket: WSData = {
      id: "socket-1", deviceId: "d1", focusedTopicId: null, lastPong: 0,
      principal: { principals: initial.list, confined: initial.confined, rev: initial.rev },
    };
    const frame = { type: "stream:end", topicId: "private-topic" };

    expect(socketMayReceiveFrame(db, socket, frame)).toBe(true);
    const before = principalsRev(db);
    db.query("DELETE FROM installation_owners WHERE person_id = 'p1'").run();
    expect(principalsRev(db)).toBeGreaterThan(before);

    expect(socketMayReceiveFrame(db, socket, frame)).toBe(false);
    expect(socket.principal?.confined).toBe(true);
    expect(socket.principal?.rev).toBe(principalsRev(db));
    db.close();
  });
});
