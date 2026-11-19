/** @covers MACHINE-01 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNodeDevice, markNodeDevice, mayDriveNodeRuns, ownsNodeRun, recordNodeRunCaller } from "./node-scope";
import { hashToken } from "./device-auth";
import { resolveIdentity } from "./identity";
import { TASKS_DDL } from "../db/test-schema";

const migrationsDir = join(import.meta.dir, "../db/migrations");
const sql = (file: string) => readFileSync(join(migrationsDir, file), "utf-8");
const BEFORE = ["080-devices.sql", "082-task-shares.sql", "083-grants.sql", "084-people-orgs.sql", "20261109100000-screen-devices.sql", "20261118110000-primary-state.sql"];
const NODE_DEVICES = "20261119100000-node-devices.sql";
/** The tables the migration reads for a person's hand, as every real database already has them. */
const HUMAN_TRACES = [
  "CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, auth_device_id TEXT)",
  "CREATE TABLE messages (id TEXT PRIMARY KEY, author_device_id TEXT)",
];
/** The label the server stored for a pairing whose user agent names no platform: every Topics server before 18/11. */
const SERVER_LABEL = "Dispositivo sconosciuto"; // allow-italian: the exact label the server stored
const RUN_PREFIX = "node-run:";

function schema(db: Database): void {
  db.run(TASKS_DDL);
  db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT)");
  for (const ddl of HUMAN_TRACES) db.run(ddl);
  for (const f of BEFORE) db.exec(sql(f));
}

function syntheticDb(path: string, channel: boolean): void {
  const db = new Database(path);
  schema(db);
  db.run("INSERT INTO people (id, display_name, created_at, updated_at) VALUES ('owner', 'Owner', 1, 1)");
  db.run("DELETE FROM installation_owners");
  db.run("INSERT INTO installation_owners (person_id, added_at, is_default) VALUES ('owner', 1, 1)");
  const add = db.query("INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, first_ip, revoked_at, role, person_id) VALUES (?, ?, ?, 1, 1, '127.0.0.1', NULL, 'owner', 'owner')");
  // Two machines that paired this node before the channel was recorded, as on the real fleet.
  add.run("studio-mac", SERVER_LABEL, hashToken("t-mac"));
  add.run("office-pc", SERVER_LABEL, hashToken("t-pc"));
  add.run("phone", "iPhone", hashToken("t-phone"));
  add.run("browser", "Mac", hashToken("t-browser"));
  // The same fallback label, but a person's: it subscribed to notifications, or wrote in a chat.
  add.run("old-tablet", SERVER_LABEL, hashToken("t-tablet"));
  add.run("odd-browser", SERVER_LABEL, hashToken("t-odd"));
  db.run("INSERT INTO push_subscriptions (endpoint, auth_device_id) VALUES ('https://push.test/1', 'old-tablet')");
  db.run("INSERT INTO messages (id, author_device_id) VALUES ('m-1', 'odd-browser')");
  if (channel) db.run("UPDATE primary_state SET channel_device_id = 'studio-mac', channel_machine_id = 'machine-mac' WHERE id = 1");
  db.close();
}

const cookie = (t: string) => `topics_device=${t}`;
const addTask = (db: Database, id: string, claudeTaskId: string | null) =>
  db.query("INSERT INTO tasks (id, project_id, text, status, claude_task_id, created_at, updated_at) VALUES (?, 'p', 'card', 'todo', ?, '2026-11-19', '2026-11-19')").run(id, claudeTaskId);

function withTempDb(channel: boolean, fn: (live: string, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "node-devices-"));
  try {
    const live = join(dir, "topics.db");
    syntheticDb(live, channel);
    fn(live, dir);
  } finally {
    // Windows keeps a closed SQLite file locked until the handle is collected: the folder is a temp one either way.
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* left to the OS temp sweep */ }
  }
}

describe("migration 20261119100000-node-devices on a synthetic database", () => {
  test("channel NULL, backed up first: both machines become node, phone, browser and a person's labelled devices stay owner, and a primary run still works on a migrated machine", () => {
    withTempDb(false, (live, dir) => {
      // The backup the deploy takes before the migration runs (docs/backup-pre-migration-policy.md).
      const backup = join(dir, "topics.db.bak-pre-node-devices");
      copyFileSync(live, backup);

      const db = new Database(live);
      db.exec(sql(NODE_DEVICES));
      const marked = () => db.query("SELECT device_id, machine_id, origin FROM node_devices ORDER BY device_id").all();
      expect(marked()).toEqual([
        { device_id: "office-pc", machine_id: null, origin: "migrated" },
        { device_id: "studio-mac", machine_id: null, origin: "migrated" },
      ]);
      // Run twice (a boot that replays it) and it adds nothing.
      db.exec(sql(NODE_DEVICES));
      expect(marked()).toHaveLength(2);

      // The role is read from the database: no header is involved.
      expect(resolveIdentity(db, cookie("t-mac"), false)).toMatchObject({ node: true, confined: false, personId: "owner" });
      expect(resolveIdentity(db, cookie("t-pc"), false).node).toBe(true);
      for (const t of ["t-phone", "t-browser", "t-tablet", "t-odd"]) {
        expect(resolveIdentity(db, cookie(t), false), t).toMatchObject({ node: false, confined: false });
      }

      // No channel: the migrated machines still send and follow their runs, as before the migration.
      expect(mayDriveNodeRuns(db, "studio-mac")).toBe(true);
      expect(mayDriveNodeRuns(db, "office-pc")).toBe(true);
      addTask(db, "run-1", `${RUN_PREFIX}origin-1`);
      recordNodeRunCaller(db, "run-1", "studio-mac");
      expect(ownsNodeRun(db, "run-1", "studio-mac", RUN_PREFIX)).toBe(true);
      expect(ownsNodeRun(db, "run-1", "office-pc", RUN_PREFIX), "another machine does not touch the Mac's run").toBe(false);

      // A secondary paired after the migration: not a driver while the machines from before exist.
      db.query("INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, first_ip, revoked_at, role) VALUES ('secondary', 'pc-d', ?, 1, 1, NULL, NULL, 'owner')").run(hashToken("t-d"));
      markNodeDevice(db, "secondary", null, "paired");
      expect(mayDriveNodeRuns(db, "secondary")).toBe(false);
      db.close();

      const restored = new Database(backup, { readonly: true });
      expect(restored.query("SELECT name FROM sqlite_master WHERE name = 'node_devices'").get()).toBeNull();
      expect((restored.query("SELECT COUNT(*) AS n FROM devices").get() as { n: number }).n).toBe(6);
      restored.close();
    });
  });

  test("with a channel, only its device drives runs, a normal card is nobody's run, and the same machine paired again keeps its runs", () => {
    withTempDb(true, (live) => {
      const db = new Database(live);
      db.exec(sql(NODE_DEVICES));
      expect(db.query("SELECT machine_id FROM node_devices WHERE device_id = 'studio-mac'").get()).toEqual({ machine_id: "machine-mac" });
      expect(mayDriveNodeRuns(db, "studio-mac")).toBe(true);
      expect(mayDriveNodeRuns(db, "office-pc")).toBe(false);
      addTask(db, "card-1", null);
      expect(ownsNodeRun(db, "card-1", "studio-mac", RUN_PREFIX)).toBe(false);
      addTask(db, "run-2", `${RUN_PREFIX}origin-2`);
      recordNodeRunCaller(db, "run-2", "studio-mac");
      db.query("INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, first_ip, revoked_at, role) VALUES ('studio-mac-2', 'studio-mac', ?, 1, 1, NULL, NULL, 'owner')").run(hashToken("t-mac-2"));
      markNodeDevice(db, "studio-mac-2", "machine-mac", "paired");
      expect(ownsNodeRun(db, "run-2", "studio-mac-2", RUN_PREFIX)).toBe(true);
      // Deleting the device takes the mark with it.
      db.run("PRAGMA foreign_keys = ON");
      db.run("DELETE FROM devices WHERE id = 'office-pc'");
      expect(isNodeDevice(db, "office-pc")).toBe(false);
      db.close();
    });
  });

  test("a node with no channel and no devices migrates to an empty table", () => {
    const db = new Database(":memory:");
    schema(db);
    db.exec(sql(NODE_DEVICES));
    expect(db.query("SELECT COUNT(*) AS n FROM node_devices").get()).toEqual({ n: 0 });
    db.close();
  });
});
