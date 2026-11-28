/**
 * @covers MACHINE-07
 *
 * The primary that comes back after a node claimed its place (track T9). The
 * old primary calls a node through the REAL node client; the node answers with
 * its REAL `rejectStale` at a higher epoch. From that answer on the old
 * primary's DB refuses writes, its own writers stop, and the next boot sets
 * the DB aside as `topics.db.prima-<epoch>`. Any other 409 changes nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, initDatabase, isFencedWriteError } from "../db";
import { bootHoldRefusal, setPrimaryFence } from "./primary-fence";
import {
  createPrimaryRole, fenceInternalWrites, holdInternalWritesUntilNodesAnswer, initPrimaryRole, isThisServerPrimary, onStaleAnswer, type PrimaryRole,
  releaseBootHold,
} from "./primary-role";
import { applyPendingPrimaryChange, DB_NAME, readRetired } from "./primary-switch";
import { nodeForUrl, wireReplacedPrimary } from "./primary-replaced";
import { createNodeClient } from "../services/node-client";

const NODE_URL = "https://node.example.test:3333";
const STAMP = "2026-01-01T00:00:00.000Z";
const migration = readFileSync(join(import.meta.dir, "../db/migrations/20261118110000-primary-state.sql"), "utf-8");

let root: string;
let previousDataDir: string | undefined;
let db: Database;
let appDataDir: string;
let role: PrimaryRole;
let restarts: number;
let replicaStops: number;
const nodeDatabases: Database[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "primary-replaced-"));
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = join(root, "data");
  db = initDatabase(join(import.meta.dir, "..", ".."), root);
  appDataDir = join(root, "app-data");
  mkdirSync(appDataDir, { recursive: true });
  // The active role: the node client reads the epoch it sends from there.
  role = initPrimaryRole({ db, stateFile: join(appDataDir, "primary-state.json"), localMachineId: () => "m-old", log: () => {} });
  role.adopt({ primaryMachineId: "m-old", epoch: 3 });
  restarts = 0;
  replicaStops = 0;
  wireReplacedPrimary({
    appDataDir,
    role,
    // The node this server paired: the same matching the boot wires.
    machineFor: (url) => nodeForUrl([{ id: "m-node", name: "node", baseUrl: NODE_URL }], url),
    stopReplica: () => { replicaStops++; return null; },
    restart: () => { restarts++; },
    now: () => STAMP,
    log: () => {},
  });
});

afterEach(() => {
  onStaleAnswer(null);
  // Back to "no primary chosen": no epoch on the calls of the next test file.
  const blank = new Database(":memory:");
  nodeDatabases.push(blank);
  blank.exec(migration);
  initPrimaryRole({ db: blank, stateFile: join(root, "none.json"), localMachineId: () => "m-none", log: () => {} });
  setPrimaryFence(null);
  fenceInternalWrites(false);
  releaseBootHold();
  closeDatabase();
  for (const d of nodeDatabases.splice(0)) d.close();
  if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
  try { rmSync(root, { recursive: true, force: true }); } catch { /* temp dir cleanup only */ }
});

/** The old primary's client to a node whose role sits at `nodeEpoch`; the node answers with its real stale check, else `otherwise`. */
function clientOfNode(nodeEpoch: number, otherwise: () => Response = () => new Response("{}", { status: 404 })) {
  const nodeDb = new Database(":memory:");
  nodeDatabases.push(nodeDb);
  nodeDb.exec(migration);
  const nodeRole = createPrimaryRole({ db: nodeDb, stateFile: join(root, `node-${nodeEpoch}.json`), localMachineId: () => "m-node", log: () => {} });
  nodeRole.adopt({ primaryMachineId: "m-node", epoch: nodeEpoch });
  return createNodeClient({
    fetch: async (input, init) => nodeRole.rejectStale(new Request(String(input), init as RequestInit)) ?? otherwise(),
    now: () => Date.now(),
    wait: async () => {},
    version: "test",
    hostname: "old",
  });
}

function writeOnce(): unknown {
  try {
    db.run("INSERT INTO projects (id, name, slug, path, created_at, updated_at) VALUES ('p', 'P', 'p', '/w/p', ?, ?)", [STAMP, STAMP]);
    return null;
  } catch (err) {
    return err;
  }
}

const call = (client: ReturnType<typeof clientOfNode>, baseUrl = NODE_URL) =>
  client.readRun({ baseUrl, token: "t", runId: "probe" }).then(() => null, (err: unknown) => err);

describe("a primary replaced while it was away", () => {
  test("the node's stale answer fences the DB at once and the next boot sets it aside as .prima-<epoch>", async () => {
    // The node claimed the primary at epoch 4 while this server, at 3, was off.
    expect(await call(clientOfNode(4))).not.toBeNull();

    expect(readRetired(appDataDir)).toEqual({ epoch: 4, toMachineId: "m-node", toName: "node", at: STAMP, phase: "pending-set-aside" });
    expect(isThisServerPrimary()).toBe(false);
    expect(isFencedWriteError(writeOnce())).toBe(true);
    expect(restarts).toBe(1);
    // The replica stops before the restart renames the DB it watches.
    expect(replicaStops).toBe(1);

    // The restart: the process ends (every handle and the in-memory fence go with it), then the
    // boot renames the DB before anything opens it.
    setPrimaryFence(null);
    closeDatabase();
    // Windows keeps the SQLite file locked after an in-process close, so the rename is measured on the
    // other platforms only (CI runs Linux); the marker above is what drives it everywhere.
    if (process.platform === "win32") return;
    const dbPath = join(root, "data", DB_NAME);
    expect(existsSync(dbPath)).toBe(true);
    const outcome = applyPendingPrimaryChange({
      stateDir: root, secretsDir: join(root, ".topics-secrets"), dbPath, appDataDir, projectsDir: join(root, "projects"), log: () => {},
    });
    expect(outcome).toBe("set-aside");
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}.prima-4`)).toBe(true);
    expect(readRetired(appDataDir)?.phase).toBe("set-aside");
  });

  test("a node at the same epoch, or a 409 that is not about the epoch, changes nothing", async () => {
    expect(await call(clientOfNode(3))).not.toBeNull();
    const conflict = () => new Response(JSON.stringify({ code: "run_conflict", epoch: 9 }), { status: 409 });
    expect(await call(clientOfNode(3, conflict))).not.toBeNull();

    expect(readRetired(appDataDir)).toBeNull();
    expect(isThisServerPrimary()).toBe(true);
    expect(writeOnce()).toBeNull();
    expect(restarts).toBe(0);
  });

  test("a newer epoch from a URL that is not a paired node, or from a pairing, is only logged", async () => {
    // A server that is not the paired node: another port, another host, a path that only shares a prefix.
    for (const stranger of ["https://node.example.test:33334", "https://elsewhere.example.test:3333", `${NODE_URL}0`]) {
      expect(await call(clientOfNode(99), stranger)).not.toBeNull();
    }
    // A pairing goes to a URL nobody vouched for yet, even the node's own.
    expect(await clientOfNode(99).pairRequest(NODE_URL).then(() => null, (err: unknown) => err)).not.toBeNull();

    expect(readRetired(appDataDir)).toBeNull();
    expect(isThisServerPrimary()).toBe(true);
    expect(writeOnce()).toBeNull();
    expect(restarts + replicaStops).toBe(0);
  });

  test("a primary back from being away writes nothing until it is released", () => {
    holdInternalWritesUntilNodesAnswer();
    expect(isThisServerPrimary()).toBe(false);
    expect(bootHoldRefusal("/api/tasks", "POST")?.status).toBe(503);
    // Reads, the live channel, the node routes and the login stay open.
    expect(bootHoldRefusal("/api/tasks", "GET")).toBeNull();
    expect(bootHoldRefusal("/ws", "GET")).toBeNull();
    expect(bootHoldRefusal("/api/nodes/runs/x", "POST")).toBeNull();
    expect(bootHoldRefusal("/api/auth/login", "POST")).toBeNull();
    releaseBootHold();
    expect(isThisServerPrimary()).toBe(true);
    expect(bootHoldRefusal("/api/tasks", "POST")).toBeNull();
  });

  test("a server that already is a secondary does not retire on a node's answer", async () => {
    role.adopt({ primaryMachineId: "m-other", epoch: 4 });
    expect(await call(clientOfNode(5))).not.toBeNull();
    expect(readRetired(appDataDir)).toBeNull();
    expect(restarts).toBe(0);
  });
});
