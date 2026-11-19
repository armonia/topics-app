/** @covers MACHINE-01 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNodeAllowedRequest, isNodeDevice, isTopicsServerAgent, markNodeDevice, mayDriveRuns, ownsNodeRun, serverAgentHost, shouldLearnNodeDevice, signNodeRun } from "./node-scope";
import { hashToken } from "./device-auth";
import { resolveIdentity } from "./identity";
import { TASKS_DDL } from "../db/test-schema";

const migrationsDir = join(import.meta.dir, "../db/migrations");
const sql = (file: string) => readFileSync(join(migrationsDir, file), "utf-8");
const BEFORE = ["080-devices.sql", "082-task-shares.sql", "083-grants.sql", "084-people-orgs.sql", "20261109100000-screen-devices.sql", "20261118110000-primary-state.sql"];
const NODE_DEVICES = "20261119100000-node-devices.sql";

describe("the node scope", () => {
  test("every call a primary makes on its node with the node cookie is open", () => {
    const calls: Array<[string, string]> = [
      ["POST", "/api/nodes/runs"],
      ["GET", "/api/nodes/runs/run-1"],
      ["GET", "/api/nodes/runs/__probe__"],
      ["DELETE", "/api/nodes/runs/run-1"],
      ["GET", "/api/nodes/runs/run-1/bundle"],
      ["GET", "/api/providers/snapshot"],
      ["GET", "/api/system/machine-metrics"],
      ["GET", "/api/system/machine-security"],
      ["GET", "/api/system/machine-readout"],
    ];
    for (const [m, p] of calls) expect(isNodeAllowedRequest(p, m), `${m} ${p}`).toBe(true);
  });

  test("what a human does is shut: commands, topics, sessions, pairing, settings, devices, the socket", () => {
    const shut: Array<[string, string]> = [
      ["POST", "/api/sessions/s-1/commands/run"],
      ["POST", "/api/topics"],
      ["POST", "/api/terminal/sessions"],
      ["POST", "/api/auth/pair/approve"],
      ["GET", "/api/auth/pair/pending"],
      ["PATCH", "/api/settings"],
      ["GET", "/api/auth/devices"],
      ["DELETE", "/api/auth/devices/d-1"],
      ["POST", "/api/nodes/delegated-requests/r-1/approve"],
      ["GET", "/api/nodes/delegated-requests"],
      ["PATCH", "/api/nodes/runs/run-1"],
      ["POST", "/api/nodes/runs/run-1/bundle"],
      ["GET", "/api/nodes/runs/run-1/bundle/extra"],
      ["POST", "/api/providers/snapshot"],
      ["GET", "/ws"],
    ];
    for (const [m, p] of shut) expect(isNodeAllowedRequest(p, m), `${m} ${p}`).toBe(false);
  });

  test("a Topics server is told apart by the user agent it sends its nodes, a browser is not one", () => {
    expect(isTopicsServerAgent("Topics/2.4.51 (studio-pc)")).toBe(true);
    expect(serverAgentHost("Topics/2.4.51 (studio-pc)")).toBe("studio-pc");
    for (const ua of [null, "", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X)", "Bun/1.3.0", "curl/8.7.1"]) {
      expect(isTopicsServerAgent(ua)).toBe(false);
      expect(serverAgentHost(ua)).toBeNull();
    }
    expect(shouldLearnNodeDevice("/api/nodes/runs/__probe__", "Topics/2.4.51 (studio-pc)")).toBe(true);
    expect(shouldLearnNodeDevice("/api/topics", "Topics/2.4.51 (studio-pc)")).toBe(false);
    expect(shouldLearnNodeDevice("/api/nodes/runs", "Mozilla/5.0 (Macintosh)")).toBe(false);
  });
});

describe("migration 20261119100000-node-devices on a synthetic database", () => {
  /** What the deploy runs the migration on: every table it reads, at the version before it. */
  function baseDb(db: Database): void {
    db.run(TASKS_DDL);
    db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT)");
    db.run("CREATE TABLE push_subscriptions (id INTEGER PRIMARY KEY, endpoint TEXT, auth_device_id TEXT)");
    db.run("CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT, author_device_id TEXT)");
    for (const f of BEFORE) db.exec(sql(f));
    db.run("INSERT INTO people (id, display_name, created_at, updated_at) VALUES ('owner', 'Owner', 1, 1)");
    db.run("DELETE FROM installation_owners");
    db.run("INSERT INTO installation_owners (person_id, added_at, is_default) VALUES ('owner', 1, 1)");
  }
  /** `name` is what the pairing wrote: the platform a browser names, or the label for a user agent naming none. */
  function addDevice(db: Database, id: string, name: string, lastSeenAt: number): void {
    db.query("INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, first_ip, revoked_at, role, person_id) VALUES (?, ?, ?, 1, ?, NULL, NULL, 'owner', 'owner')")
      .run(id, name, hashToken(`t-${id}`), lastSeenAt);
  }
  function addTask(db: Database, id: string, runKey: string | null): void {
    db.query("INSERT INTO tasks (id, project_id, text, claude_task_id, created_at, updated_at) VALUES (?, 'p', 'a card', ?, '', '')").run(id, runKey);
  }
  const UNKNOWN = "Dispositivo sconosciuto"; // allow-italian: the device name the server writes for a user agent naming no platform
  const cookie = (id: string) => `topics_device=t-${id}`;

  test("backed up first, with a channel: the holder and every machine credential become node, people stay owner; the backup restores the state before", () => {
    const dir = mkdtempSync(join(tmpdir(), "node-devices-"));
    try {
      const live = join(dir, "topics.db");
      const seed = new Database(live);
      baseDb(seed);
      addDevice(seed, "primary-mac", "Mac", 50);
      addDevice(seed, "phone", "iPhone", 40);
      addDevice(seed, "old-server", UNKNOWN, 30);
      seed.run("UPDATE primary_state SET channel_device_id = 'primary-mac', channel_machine_id = 'machine-mac' WHERE id = 1");
      seed.close();
      // The backup the deploy takes before the migration runs (docs/backup-pre-migration-policy.md).
      const backup = join(dir, "topics.db.bak-pre-node-devices");
      copyFileSync(live, backup);

      const db = new Database(live);
      db.exec(sql(NODE_DEVICES));
      expect(db.query("SELECT device_id, machine_id, legacy_driver FROM node_devices ORDER BY device_id").all()).toEqual([
        { device_id: "old-server", machine_id: null, legacy_driver: 0 },
        { device_id: "primary-mac", machine_id: "machine-mac", legacy_driver: 0 },
      ]);
      expect(resolveIdentity(db, cookie("primary-mac"), false)).toMatchObject({ node: true, confined: false, personId: "owner" });
      expect(resolveIdentity(db, cookie("old-server"), false).node).toBe(true);
      expect(resolveIdentity(db, cookie("phone"), false)).toMatchObject({ node: false, confined: false });
      // With a channel, only its holder starts runs.
      expect(mayDriveRuns(db, "primary-mac")).toBe(true);
      expect(mayDriveRuns(db, "old-server")).toBe(false);
      // Deleting the device takes the mark with it.
      db.run("PRAGMA foreign_keys = ON");
      db.run("DELETE FROM devices WHERE id = 'old-server'");
      expect(isNodeDevice(db, "old-server")).toBe(false);
      db.close();

      const restored = new Database(backup, { readonly: true });
      expect(restored.query("SELECT name FROM sqlite_master WHERE name = 'node_devices'").get()).toBeNull();
      expect((restored.query("SELECT COUNT(*) AS n FROM devices").get() as { n: number }).n).toBe(3);
      restored.close();
    } finally {
      // Windows keeps a closed SQLite file locked until the handle is collected: the folder is a temp one either way.
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* left to the OS temp sweep */ }
    }
  });

  test("with no channel (a node paired before 18/11): two machines become node, phone and browser stay owner, the machine seen last drives the runs", () => {
    const db = new Database(":memory:");
    baseDb(db);
    addDevice(db, "mac-live", UNKNOWN, 900);
    addDevice(db, "mac-stale", UNKNOWN, 100);
    addDevice(db, "phone", "iPhone", 950);
    addDevice(db, "browser", "Mac", 960);
    // A person on a browser the server could not name: what a person does keeps it owner.
    addDevice(db, "odd-browser", UNKNOWN, 970);
    db.run("INSERT INTO push_subscriptions (endpoint, auth_device_id) VALUES ('https://push.example/1', 'odd-browser')");
    db.run("INSERT INTO messages (id, content, author_device_id) VALUES ('m1', 'hello', 'odd-browser')");
    db.exec(sql(NODE_DEVICES));

    for (const id of ["mac-live", "mac-stale"]) expect(resolveIdentity(db, cookie(id), false).node, id).toBe(true);
    for (const id of ["phone", "browser", "odd-browser"]) expect(resolveIdentity(db, cookie(id), false), id).toMatchObject({ node: false, confined: false });

    expect(mayDriveRuns(db, "mac-live")).toBe(true);
    expect(mayDriveRuns(db, "mac-stale")).toBe(false);
    // The runs the primary started before the migration are unsigned: the driver keeps them, nobody else.
    addTask(db, "run-old", "node-run:o1");
    addTask(db, "card", null);
    expect(ownsNodeRun(db, "mac-live", "run-old")).toBe(true);
    expect(ownsNodeRun(db, "mac-stale", "run-old")).toBe(false);
    expect(ownsNodeRun(db, "mac-live", "card"), "a normal card is never a run").toBe(false);
    // A run started after it is signed by who asked, and only that device owns it.
    addTask(db, "run-new", "node-run:o2");
    signNodeRun(db, "run-new", "mac-live");
    expect(ownsNodeRun(db, "mac-live", "run-new")).toBe(true);
    expect(ownsNodeRun(db, "mac-stale", "run-new")).toBe(false);
    db.close();
  });

  test("with no channel and no legacy mark, the only machine credential drives the runs; two drive none", () => {
    const db = new Database(":memory:");
    baseDb(db);
    db.exec(sql(NODE_DEVICES));
    expect(db.query("SELECT COUNT(*) AS n FROM node_devices").get()).toEqual({ n: 0 });
    addDevice(db, "first-primary", "studio-pc", 1);
    markNodeDevice(db, "first-primary", null);
    expect(mayDriveRuns(db, "first-primary")).toBe(true);
    addDevice(db, "secondary", "laptop", 2);
    markNodeDevice(db, "secondary", null);
    expect(mayDriveRuns(db, "first-primary"), "nobody, until a primary takes the channel").toBe(false);
    db.close();
  });
});
