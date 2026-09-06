/**
 * Phase D · multi-machine integration test.
 * Covers MachineStore upsertLocal idempotence, REST routes, and the FK
 * SET NULL on `topics.machine_id` when a machine is deleted.
  * @covers MACHINE-01
  * @covers MACHINE-02
 */
import { describe, expect, test, beforeAll, beforeEach } from "bun:test";
import { statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import type { NodeClient } from "../../server/services/node-client";

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
  test("MACHINE-02: la stretta di mano scrive il gettone a 0600, crea la riga col base_url, e nessuna risposta lo espone", async () => {
    const { createMachinesRouter } = await import("../../server/routes/machines");
    const ctx = await createTestAppContext();
    ctx.machineStore.upsertLocal();
    const TOKEN = "node-device-token-0123456789abcdef";
    const seen: string[] = [];
    // A node that approves on the second poll. The claim must never travel to
    // the client, so the fake records it here and the assertions look for it
    // in every body that went out of the router.
    const fakeNode: NodeClient = {
      pairRequest: async (baseUrl) => {
        seen.push(`request:${baseUrl}`);
        return { requestId: "req-1", code: "424242", claim: "the-claim-that-must-stay-here", name: "Studio PC", expiresInMs: 180_000 };
      },
      pairWait: async ({ claim }) => {
        seen.push(`wait:${claim}`);
        return seen.filter((s) => s.startsWith("wait:")).length < 2
          ? { state: "pending" }
          : { state: "approved", token: TOKEN, name: "Studio PC" };
      },
      createRun: async () => { throw new Error("not in this test"); },
      readRun: async () => { throw new Error("not in this test"); },
      fetchBundle: async () => { throw new Error("not in this test"); },
      cancelRun: async () => { throw new Error("not in this test"); },
    };
    ctx.nodeClient = fakeNode;
    const router = createMachinesRouter(ctx);
    const call = async (method: string, path: string, body?: unknown) => {
      const url = new URL(`http://h${path}`);
      const res = await router(
        new Request(url, {
          method,
          headers: body ? { "content-type": "application/json" } : {},
          body: body ? JSON.stringify(body) : undefined,
        }),
        url, path, method,
      );
      return { status: res?.status ?? 0, text: await res!.text() };
    };

    const bad = await call("POST", "/api/machines/pair", { baseUrl: "ftp://nope" });
    expect(bad.status).toBe(400);

    const opened = await call("POST", "/api/machines/pair", { baseUrl: "https://studio.local:8443/" });
    expect(opened.status).toBe(200);
    const openedBody = JSON.parse(opened.text);
    expect(openedBody.code).toBe("424242");
    expect(typeof openedBody.pairingId).toBe("string");
    expect(opened.text).not.toContain("the-claim-that-must-stay-here");
    expect(opened.text).not.toContain("req-1");
    expect(seen[0]).toBe("request:https://studio.local:8443");

    const first = await call("GET", `/api/machines/pair/${openedBody.pairingId}`);
    expect(JSON.parse(first.text)).toEqual({ state: "pending" });
    expect(seen[1]).toBe("wait:the-claim-that-must-stay-here");

    const second = await call("GET", `/api/machines/pair/${openedBody.pairingId}`);
    expect(second.status).toBe(200);
    const approved = JSON.parse(second.text);
    expect(approved.state).toBe("approved");
    expect(approved.machine.baseUrl).toBe("https://studio.local:8443");
    expect(approved.machine.hostname).toBe("studio.local:8443");
    expect(approved.machine.name).toBe("Studio PC");
    expect(second.text).not.toContain(TOKEN);

    const tokenFile = join(ctx.STATE_DIR, "nodes", `${approved.machine.id}.token`);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(tokenFile, "utf8").trim()).toBe(TOKEN);

    const list = await call("GET", "/api/machines");
    expect(list.text).not.toContain(TOKEN);
    const rows = JSON.parse(list.text).machines as Array<{ id: string; baseUrl: string | null }>;
    expect(rows.find((r) => r.id === approved.machine.id)?.baseUrl).toBe("https://studio.local:8443");
    const one = await call("GET", `/api/machines/${approved.machine.id}`);
    expect(one.text).not.toContain(TOKEN);

    // A handshake consumed is a handshake gone: polling it again is `expired`.
    const again = await call("GET", `/api/machines/pair/${openedBody.pairingId}`);
    expect(JSON.parse(again.text)).toEqual({ state: "expired" });

    const { closeDatabase } = await import("../../server/db");
    closeDatabase();
  });

  test("MACHINE-02b: un nodo che rifiuta l'host risponde host_not_allowed, non un generico irraggiungibile", async () => {
    const { createMachinesRouter } = await import("../../server/routes/machines");
    const { NodeError } = await import("../../server/services/node-client");
    const ctx = await createTestAppContext();
    const reasons = ["host_not_allowed", "tls_untrusted", "unreachable"] as const;
    let i = 0;
    ctx.nodeClient = {
      pairRequest: async () => { throw new NodeError(reasons[i++], "refused"); },
      pairWait: async () => ({ state: "expired" }),
      createRun: async () => { throw new Error("not in this test"); },
      readRun: async () => { throw new Error("not in this test"); },
      fetchBundle: async () => { throw new Error("not in this test"); },
      cancelRun: async () => { throw new Error("not in this test"); },
    };
    const router = createMachinesRouter(ctx);
    const codes: string[] = [];
    for (let k = 0; k < reasons.length; k++) {
      const url = new URL("http://h/api/machines/pair");
      const res = await router(
        new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseUrl: "https://studio.local" }) }),
        url, "/api/machines/pair", "POST",
      );
      expect(res?.status).toBe(502);
      codes.push((await res!.json()).code);
    }
    expect(codes).toEqual([...reasons]);
    const { closeDatabase } = await import("../../server/db");
    closeDatabase();
  });
});
