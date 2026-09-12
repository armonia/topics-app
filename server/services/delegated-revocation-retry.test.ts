import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createDelegatedRevocationRetry } from "./delegated-revocation-retry";

/** @covers GUEST-17 */

function database(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE delegated_node_requests (
    id TEXT PRIMARY KEY,direction TEXT,state TEXT,base_url TEXT,remote_request_id TEXT,
    claim_secret TEXT,capability_id TEXT,authorization_id TEXT,revoke_pending INTEGER,
    last_error TEXT,updated_at INTEGER)`);
  db.run(`CREATE TABLE tasks (id TEXT PRIMARY KEY,project_id TEXT)`);
  db.run(`CREATE TABLE delegated_node_runs (
    run_id TEXT PRIMARY KEY,authorization_id TEXT,cancel_confirmed_at INTEGER,cancel_error TEXT)`);
  return db;
}

describe("delegated revocation retry", () => {
  test("origin retries after backoff with no browser request", async () => {
    const db = database();
    db.run(`INSERT INTO delegated_node_requests VALUES
      ('req','origin','revoked','https://node','remote-req','claim','cap',NULL,1,NULL,0)`);
    let now = 1_000;
    let calls = 0;
    const retry = createDelegatedRevocationRetry({
      db,
      now: () => now,
      backoffMs: 100,
      nodeClient: {
        revokeDelegatedRequest: async () => {
          calls += 1;
          if (calls === 1) throw new Error("offline");
        },
      },
    });

    await retry.tick({ force: true });
    expect(calls).toBe(1);
    expect(db.query("SELECT revoke_pending FROM delegated_node_requests WHERE id='req'").get())
      .toEqual({ revoke_pending: 1 });
    now += 99;
    await retry.tick();
    expect(calls).toBe(1);
    now += 1;
    await retry.tick();
    expect(calls).toBe(2);
    expect(db.query("SELECT state,revoke_pending,last_error FROM delegated_node_requests WHERE id='req'").get())
      .toEqual({ state: "revoked", revoke_pending: 0, last_error: null });
  });

  test("a fresh service after restart cancels exact pending node runs", async () => {
    const db = database();
    db.run(`INSERT INTO delegated_node_requests VALUES
      ('req','node','approved',NULL,'remote-req',NULL,'cap','auth',1,'delegated_cancel_unconfirmed',0)`);
    db.run("INSERT INTO tasks VALUES ('run-exact','project-local')");
    db.run("INSERT INTO delegated_node_runs VALUES ('run-exact','auth',NULL,'offline')");
    const deleted: Array<[string, string]> = [];

    // Constructing a new runner models process bootstrap: no in-memory queue is
    // needed, the durable revoke_pending row is the queue.
    const restarted = createDelegatedRevocationRetry({
      db,
      now: () => 10_000,
      backoffMs: 0,
      deleteBoardTask: async (projectId, taskId) => {
        deleted.push([projectId, taskId]);
        return new Response(null, { status: 204 });
      },
    });
    await restarted.tick();

    expect(deleted).toEqual([["project-local", "run-exact"]]);
    expect(db.query("SELECT cancel_confirmed_at,cancel_error FROM delegated_node_runs WHERE run_id='run-exact'").get())
      .toEqual({ cancel_confirmed_at: 10_000, cancel_error: null });
    expect(db.query("SELECT state,revoke_pending,last_error FROM delegated_node_requests WHERE id='req'").get())
      .toEqual({ state: "revoked", revoke_pending: 0, last_error: null });
  });

  test("overlapping ticks share one in-flight pass", async () => {
    const db = database();
    db.run(`INSERT INTO delegated_node_requests VALUES
      ('req','origin','revoked','https://node','remote-req','claim','cap',NULL,1,NULL,0)`);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const retry = createDelegatedRevocationRetry({
      db,
      nodeClient: { revokeDelegatedRequest: async () => { calls += 1; await gate; } },
    });
    const first = retry.tick({ force: true });
    const second = retry.tick({ force: true });
    release();
    expect(await first).toEqual(await second);
    expect(calls).toBe(1);
  });
});
