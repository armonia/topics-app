/** @covers MACHINE-01 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNodeAllowedRequest, isNodeDevice, isTopicsServerAgent, markNodeDevice, serverAgentHostname, shouldLearnNodeDevice } from "./node-scope";
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
    expect(serverAgentHostname("Topics/2.4.51 (studio-pc)")).toBe("studio-pc");
    for (const ua of [null, "", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X)", "Bun/1.3.0", "curl/8.7.1"]) {
      expect(isTopicsServerAgent(ua)).toBe(false);
      expect(serverAgentHostname(ua)).toBeNull();
    }
    expect(shouldLearnNodeDevice("/api/nodes/runs/__probe__", "Topics/2.4.51 (studio-pc)")).toBe(true);
    expect(shouldLearnNodeDevice("/api/topics", "Topics/2.4.51 (studio-pc)")).toBe(false);
    expect(shouldLearnNodeDevice("/api/nodes/runs", "Mozilla/5.0 (Macintosh)")).toBe(false);
  });
});

describe("migration 20261119100000-node-devices on a synthetic database", () => {
  function syntheticDb(path: string): void {
    const db = new Database(path);
    db.run(TASKS_DDL);
    db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT)");
    for (const f of BEFORE) db.exec(sql(f));
    db.run("INSERT INTO people (id, display_name, created_at, updated_at) VALUES ('owner', 'Owner', 1, 1)");
    db.run("DELETE FROM installation_owners");
    db.run("INSERT INTO installation_owners (person_id, added_at, is_default) VALUES ('owner', 1, 1)");
    const add = db.query("INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, first_ip, revoked_at, role, person_id) VALUES (?, ?, ?, 1, 1, NULL, NULL, 'owner', 'owner')");
    add.run("primary-mac", "Mac", hashToken("t-primary"));
    add.run("phone", "iPhone", hashToken("t-phone"));
    add.run("old-server", "Linux", hashToken("t-old"));
    db.run("UPDATE primary_state SET channel_device_id = 'primary-mac', channel_machine_id = 'machine-mac' WHERE id = 1");
    db.close();
  }
  const cookie = (t: string) => `topics_device=${t}`;

  test("backed up first, it marks the device holding the channel and nothing else; the backup restores the state before", () => {
    const dir = mkdtempSync(join(tmpdir(), "node-devices-"));
    try {
      const live = join(dir, "topics.db");
      syntheticDb(live);
      // The backup the deploy takes before the migration runs (docs/backup-pre-migration-policy.md).
      const backup = join(dir, "topics.db.bak-pre-node-devices");
      copyFileSync(live, backup);

      const db = new Database(live);
      db.exec(sql(NODE_DEVICES));
      expect(db.query("SELECT device_id, machine_id FROM node_devices").all()).toEqual([{ device_id: "primary-mac", machine_id: "machine-mac" }]);
      // Run twice (a boot that replays it) and it adds nothing.
      db.exec(sql(NODE_DEVICES));
      expect((db.query("SELECT COUNT(*) AS n FROM node_devices").get() as { n: number }).n).toBe(1);

      expect(resolveIdentity(db, cookie("t-primary"), false)).toMatchObject({ node: true, confined: false, personId: "owner" });
      expect(resolveIdentity(db, cookie("t-phone"), false)).toMatchObject({ node: false, confined: false });
      // A machine paired before the channel was recorded: owner until it calls the run routes.
      expect(resolveIdentity(db, cookie("t-old"), false).node).toBe(false);
      markNodeDevice(db, "old-server", null);
      expect(isNodeDevice(db, "old-server")).toBe(true);
      // Revoking and deleting the device takes the mark with it.
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

  test("a node with no channel and no devices migrates to an empty table", () => {
    const db = new Database(":memory:");
    db.run(TASKS_DDL);
    db.run("CREATE TABLE topics (id TEXT PRIMARY KEY, name TEXT)");
    for (const f of BEFORE) db.exec(sql(f));
    db.exec(sql(NODE_DEVICES));
    expect(db.query("SELECT COUNT(*) AS n FROM node_devices").get()).toEqual({ n: 0 });
    db.close();
  });
});
