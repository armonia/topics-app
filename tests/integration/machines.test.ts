/**
 * Phase D · multi-machine integration test.
 * Covers MachineStore upsertLocal idempotence, REST routes, and the FK
 * SET NULL on `topics.machine_id` when a machine is deleted.
 */
import { describe, expect, test, beforeAll, beforeEach, afterAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir, cleanupTestDataDir } from "./helpers";

const TEST_DATA = testTmpDir("phase-d-data");

beforeAll(async () => {
  setupTestDataDir(TEST_DATA);
  // `server/db.ts` keeps a module-level `_db` singleton. Other suites in the
  // same `bun test` run may have already called `initDatabase()` pointing at
  // a different DATA_DIR, leaving that singleton alive. If we don't close it
  // here, our first `createAppContext()` short-circuits and reuses the stale
  // handle — which then SQLITE_NOMEMs the moment we touch `worktreeStore` or
  // `machineStore` because the underlying file/db may have been closed by a
  // peer test's afterAll. Force a fresh handle bound to our DATA_DIR.
  const { closeDatabase } = await import("../../server/db");
  closeDatabase();
});

afterAll(() => cleanupTestDataDir(TEST_DATA));

describe("Phase D · multi-machine", () => {
  // Each test in this describe block builds its own AppContext, but they
  // all share the module-level `_db` singleton in `server/db.ts`. The
  // previous test's `closeDatabase()` runs synchronously, but any promise
  // it kicked off (e.g. worktree materialisation chained via
  // `chainOnProjectQueue`) can still hold references to closed prepared
  // statements and crash with SQLITE_NOMEM on the next `.get()` call.
  // Closing here at the START of each test guarantees we reach
  // `initDatabase()` with `_db === null`, drains any leftover microtask
  // from the prior test by yielding one tick, and gives us a freshly
  // initialised handle.
  beforeEach(async () => {
    const { closeDatabase } = await import("../../server/db");
    closeDatabase();
    await new Promise((r) => setTimeout(r, 0));
  });

  test("upsertLocal is idempotent: insert on first call, refresh on subsequent", async () => {
    const ctx = await createTestAppContext();
    const first = ctx.machineStore.upsertLocal();
    const second = ctx.machineStore.upsertLocal();
    expect(second.id).toBe(first.id);
    expect(Date.parse(second.lastHeartbeatAt)).toBeGreaterThanOrEqual(Date.parse(first.lastHeartbeatAt));
    const all = ctx.machineStore.list();
    expect(all.length).toBe(1); // hostname-uniqueness enforced
    const { closeDatabase } = await import("../../server/db");
    closeDatabase();
  });

  test("rename via PATCH and FK SET NULL on delete", async () => {
    const { createMachinesRouter } = await import("../../server/routes/machines");
    const ctx = await createTestAppContext();
    const m = ctx.machineStore.upsertLocal();

    // Bind a topic to the machine via direct insert (mirroring saveSingleTopic).
    const data = ctx.loadTopics();
    const id = crypto.randomUUID();
    data.topics[id] = {
      id, name: "T", slug: "t", parentId: null, links: [],
      sessionKey: "topic:" + id.slice(0, 8),
      color: "#fff", icon: "💬",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archived: false,
    };
    ctx.saveTopics(data);
    ctx.db.run("UPDATE topics SET machine_id = ? WHERE id = ?", [m.id, id]);

    // Rename via REST.
    const router = createMachinesRouter(ctx);
    const renUrl = new URL(`http://h/api/machines/${m.id}`);
    const renResp = await router(
      new Request(renUrl, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Renamed Mac" }),
      }),
      renUrl,
      `/api/machines/${m.id}`,
      "PATCH",
    );
    expect(renResp?.status).toBe(200);

    // DELETE while topic still references → 409.
    const delUrl = new URL(`http://h/api/machines/${m.id}`);
    const delResp = await router(
      new Request(delUrl, { method: "DELETE" }),
      delUrl, `/api/machines/${m.id}`, "DELETE",
    );
    expect(delResp?.status).toBe(409);

    // Clear FK and retry.
    ctx.db.run("UPDATE topics SET machine_id = NULL WHERE id = ?", [id]);
    const delResp2 = await router(
      new Request(delUrl, { method: "DELETE" }),
      delUrl, `/api/machines/${m.id}`, "DELETE",
    );
    expect(delResp2?.status).toBe(200);

    const { closeDatabase } = await import("../../server/db");
    closeDatabase();
  });

  test("markStaleOffline flips machines older than threshold", async () => {
    const ctx = await createTestAppContext();
    const local = ctx.machineStore.upsertLocal();

    // Insert a fake remote machine with old heartbeat.
    const oldTs = new Date(Date.now() - 10 * 60_000).toISOString();
    ctx.db.run(
      `INSERT INTO machines (id, name, hostname, arch, platform, daemon_version, status, last_heartbeat_at, last_seen_at, created_at, updated_at)
       VALUES (?, 'Old', 'remote-host', 'arm64', 'linux', '0.0.0', 'online', ?, ?, ?, ?)`,
      ["remote-1", oldTs, oldTs, oldTs, oldTs],
    );

    const flipped = ctx.machineStore.markStaleOffline(5 * 60_000);
    expect(flipped.length).toBe(1);
    expect(flipped[0].id).toBe("remote-1");
    expect(flipped[0].status).toBe("offline");

    // Local machine SHOULD NOT have flipped.
    const stillOnline = ctx.machineStore.get(local.id)!;
    expect(stillOnline.status).toBe("online");

    const { closeDatabase } = await import("../../server/db");
    closeDatabase();
  });
});
