/**
 * @covers MACHINE-07
 *
 * The fence of a primary switch must not break its own answer. A device that
 * was last seen more than an hour ago makes the access gate write
 * `last_seen_at`; with the DB read-only (the fence, `query_only` on the real
 * handle) that write threw SQLITE_READONLY, the front door never reached
 * `retiredRefusal`, and every request got a 500 for as long as the fence stood.
 * The DB here is the real one, opened by `initDatabase`, fenced by the real
 * `setPrimaryFence`: no lambda stands in for the read-only handle.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { closeDatabase, initDatabase } from "../db";
import { hashToken, SESSION_COOKIE } from "../lib/device-auth";
import { gatedRefusal, setPrimaryFence } from "../lib/primary-fence";
import { fenceInternalWrites } from "../lib/primary-role";
import { MOVED_CODE, type RetiredPhase } from "../lib/primary-switch";
import { createAccessGate } from "./access-gate";
import type { Database } from "bun:sqlite";

const TOKEN = "device-session";
// Paired a day ago, last seen two hours ago: well past the hour the gate waits between two writes.
const PAIRED = Date.now() - 24 * 3_600_000;
const STALE = Date.now() - 2 * 3_600_000;

let root: string;
let previousDataDir: string | undefined;
let db: Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "access-gate-fence-"));
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = join(root, "data");
  db = initDatabase(join(import.meta.dir, "..", ".."), root);
  db.run("INSERT INTO devices (id, name, token_hash, created_at, last_seen_at) VALUES ('dev-1', 'phone', ?, ?, ?)", [hashToken(TOKEN), PAIRED, STALE]);
  // An owner device: a guest is refused by the gate itself before the fence is ever asked.
  const now = Date.now();
  db.run("INSERT INTO people (id, display_name, created_at, updated_at) VALUES ('p-owner', 'owner', ?, ?)", [now, now]);
  db.run("INSERT INTO installation_owners (person_id, added_at, is_default) VALUES ('p-owner', ?, 0)", [now]);
  db.run("UPDATE devices SET person_id = 'p-owner' WHERE id = 'dev-1'");
});

afterEach(() => {
  setPrimaryFence(null);
  fenceInternalWrites(false);
  closeDatabase();
  if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
  try { rmSync(root, { recursive: true, force: true }); } catch { /* temp dir cleanup only */ }
});

/** The real gate, in front of the real DB, asked by a remote device with a valid session. */
function ask(method: string, pathname: string, extraHeaders: Record<string, string> = {}): { refused: Response | null; lastSeen: number } {
  const gate = createAccessGate({
    corsAllowOrigin: () => "",
    ctx: { db } as never,
    identityByRequest: new WeakMap(),
  });
  const req = new Request(`https://192.168.1.20:3333${pathname}`, {
    method,
    headers: { cookie: `${SESSION_COOKIE}=${TOKEN}`, host: "192.168.1.20:3333", ...extraHeaders },
  });
  const server = { requestIP: () => ({ address: "192.168.1.9", family: "IPv4", port: 5000 }) } as unknown as Server<never>;
  const refused = gatedRefusal(() => gate(req, server as never, pathname, method, true) ?? null, pathname, method);
  const row = db.query("SELECT last_seen_at AS t FROM devices WHERE id = 'dev-1'").get() as { t: number };
  return { refused, lastSeen: row.t };
}

describe("the fence still answers primary_moved", () => {
  test("without the fence the gate records the visit (the write this test is about is real)", () => {
    const { refused, lastSeen } = ask("GET", "/api/topics");
    expect(refused).toBeNull();
    expect(lastSeen).toBeGreaterThan(STALE);
  });

  for (const phase of ["fencing", "sent", "uncertain", "pending-set-aside"] as RetiredPhase[]) {
    test(`${phase}: a write gets 409 primary_moved with the new primary and epoch, a read goes through`, async () => {
      setPrimaryFence({ epoch: 7, toMachineId: "m-new", toName: "server", at: "", phase });
      expect(db.query("PRAGMA query_only").get()).toEqual({ query_only: 1 });

      const write = ask("POST", "/api/tasks");
      expect(write.refused?.status).toBe(409);
      expect(await write.refused!.json()).toMatchObject({ code: MOVED_CODE, epoch: 7, primaryMachineId: "m-new", primaryName: "server" });

      const read = ask("GET", "/api/topics");
      expect(read.refused).toBeNull();
      // Nothing was written into the DB that was handed over.
      expect(read.lastSeen).toBe(STALE);
    });
  }

  test("a credential that would be learned as a node's is not written under the fence, and the request still gets through", () => {
    setPrimaryFence({ epoch: 7, toMachineId: "m-new", toName: "server", at: "", phase: "uncertain" });
    const read = ask("GET", "/api/nodes/runs/r-1", { "user-agent": "Topics/1.0 (some-host)" });
    expect(read.refused).toBeNull();
    expect(db.query("SELECT COUNT(*) AS n FROM node_devices").get()).toEqual({ n: 0 });
  });
});
