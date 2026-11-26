/**
 * @covers MACHINE-06
 * The receiving half of a primary switch: only the channel's device stages and
 * commits, names and offsets are checked, a full upload commits and restarts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initPrimaryRole } from "../lib/primary-role";
import { countRows, INCOMING_DIR, sha256File, snapshotDatabase, type SwitchManifest } from "../lib/primary-switch";
import { createNodePrimaryRouter, NODE_PRIMARY_COMMIT_PATH, NODE_PRIMARY_INCOMING_PATH } from "./nodes-primary";
import type { AppContext } from "../types";

const migration = readFileSync(join(import.meta.dir, "../db/migrations/20261118110000-primary-state.sql"), "utf-8");
const roots: string[] = [];
const open: Database[] = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function setup(deviceId: string | null) {
  const root = mkdtempSync(join(tmpdir(), "nodes-primary-"));
  roots.push(root);
  const db = new Database(join(root, "live.db"));
  open.push(db);
  db.exec(migration);
  db.exec("CREATE TABLE tasks (id TEXT); CREATE TABLE messages (id TEXT); CREATE TABLE topics (id TEXT, session_key TEXT)");
  db.exec("INSERT INTO tasks VALUES ('a'), ('b'); INSERT INTO messages VALUES ('m'); INSERT INTO topics VALUES ('t', 'topic:t')");
  const role = initPrimaryRole({ db, stateFile: join(root, "primary-state.json"), localMachineId: () => "m-node", log: () => {} });
  db.query("INSERT INTO primary_state (id, epoch) VALUES (1, 0) ON CONFLICT(id) DO NOTHING").run();
  role.recordChannel({ deviceId: "dev-primary", machineId: "m-primary" });
  let restarts = 0;
  const ctx = {
    db,
    requestIdentity: () => (deviceId ? { role: "owner" as const, deviceId } : null),
    json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
    readJSON: (req: Request) => req.json(),
  } as unknown as AppContext;
  const router = createNodePrimaryRouter(ctx, { stateDir: join(root, "state"), hostname: () => "node-host", restart: () => { restarts++; } });
  const call = (path: string, method: string, body?: BodyInit) => {
    const url = new URL(`http://node${path}`);
    return router(new Request(url, { method, body }), url, url.pathname, method) as Promise<Response>;
  };
  return { root, db, call, restarts: () => restarts };
}

const put = (name: string, offset: number) => `${NODE_PRIMARY_INCOMING_PATH}?name=${encodeURIComponent(name)}&offset=${offset}`;

describe("nodes-primary routes", () => {
  test("another device, or none, cannot stage anything", async () => {
    for (const device of ["dev-other", null]) {
      const res = await setup(device).call(put("topics.db", 0), "PUT", "x");
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("not_channel");
    }
  });

  test("a bad name or an out of order chunk is refused", async () => {
    const s = setup("dev-primary");
    expect((await s.call(put("../escape", 0), "PUT", "x")).status).toBe(400);
    expect((await s.call(put("state/license-token", 0), "PUT", "ab")).status).toBe(200);
    expect((await s.call(put("state/license-token", 5), "PUT", "c")).status).toBe(400);
    // An upload that went wrong leaves no secret staged.
    expect(existsSync(join(s.root, "state", INCOMING_DIR))).toBe(false);
  });

  test("a refused commit drops what was staged", async () => {
    const s = setup("dev-primary");
    expect((await s.call(put("state/license-token", 0), "PUT", "ab")).status).toBe(200);
    expect(existsSync(join(s.root, "state", INCOMING_DIR))).toBe(true);
    const res = await s.call(NODE_PRIMARY_COMMIT_PATH, "POST", JSON.stringify({ version: 1, epoch: 1, toHostname: "elsewhere", files: [] }));
    expect(res.status).toBe(409);
    expect(existsSync(join(s.root, "state", INCOMING_DIR))).toBe(false);
  });

  test("a full upload from the channel commits with its counts and restarts", async () => {
    const s = setup("dev-primary");
    const copy = join(s.root, "copy.db");
    const counts = snapshotDatabase(s.db, copy);
    const bytes = readFileSync(copy);
    expect((await s.call(put("topics.db", 0), "PUT", bytes.subarray(0, 1000))).status).toBe(200);
    expect((await s.call(put("topics.db", 1000), "PUT", bytes.subarray(1000))).status).toBe(200);
    const manifest: SwitchManifest = {
      version: 1, epoch: 1, toMachineId: "m-node", toHostname: "node-host", fromMachineId: "m-primary",
      createdAt: "now", counts, files: [{ name: "topics.db", size: bytes.byteLength, sha256: await sha256File(copy) }],
    };
    const res = await s.call(NODE_PRIMARY_COMMIT_PATH, "POST", JSON.stringify(manifest));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { counts: unknown }).counts).toEqual(countRows(s.db));
    expect(s.restarts()).toBe(1);
  });

  test("a commit for another host is refused and does not restart", async () => {
    const s = setup("dev-primary");
    const res = await s.call(NODE_PRIMARY_COMMIT_PATH, "POST", JSON.stringify({ version: 1, epoch: 1, toHostname: "elsewhere", files: [] }));
    expect(res.status).toBe(409);
    expect(s.restarts()).toBe(0);
  });
});
