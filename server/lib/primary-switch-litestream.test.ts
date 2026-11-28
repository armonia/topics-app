/**
 * @covers MACHINE-07
 *
 * What a replica of the live DB path (Litestream, a process outside the
 * product) sees across a primary switch (track T4). It runs the REAL
 * `litestream` binary on a throwaway DB in a temp folder, with a `file://`
 * replica, never the production config. Skipped when `litestream` is not in PATH.
 *
 * Two claims:
 *  - while the fence is up Litestream may write into the DB (its own
 *    `_litestream_*` bookkeeping) but never into the data: every other table is
 *    byte for byte the same, and a write of ours is still refused;
 *  - after the set-aside the retired server opens its service DB under another
 *    name, so the replica never publishes a newer, empty generation: a restore
 *    "from the latest" returns the DB that was handed over.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { closeDatabase, initDatabase } from "../db";
import { bootPrimaryChange, setPrimaryFence } from "./primary-fence";
import { countRows, DB_NAME, type RetiredState, writeRetired } from "./primary-switch";
import { RETIRED_DB_NAME } from "./data-dir";
import { fenceInternalWrites } from "./primary-role";

const REPLICA_BIN = Bun.which("litestream");
const STAMP = "2026-01-01T00:00:00.000Z";
const FENCE: RetiredState = { epoch: 2, toMachineId: "m-new", toName: "new", at: STAMP, phase: "fencing" };

let root: string;
let previousDataDir: string | undefined;
let replicaProcess: ReturnType<typeof Bun.spawn> | null = null;

const dataDir = () => join(root, "data");
const livePath = () => join(dataDir(), DB_NAME);
const replicaDir = () => join(root, "replica");
const configPath = () => join(root, "litestream.yml");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "primary-litestream-"));
  previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir();
});

afterEach(() => {
  replicaProcess?.kill();
  replicaProcess = null;
  setPrimaryFence(null);
  fenceInternalWrites(false);
  closeDatabase();
  if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
  try { rmSync(root, { recursive: true, force: true }); } catch { /* temp dir cleanup only */ }
});

function seed(db: Database): void {
  db.run("INSERT INTO projects (id, name, slug, path, created_at, updated_at) VALUES ('p1', 'P1', 'p1', '/work/p1', ?, ?)", [STAMP, STAMP]);
  for (let i = 0; i < 20; i++) {
    db.run("INSERT INTO tasks (id, project_id, text, created_at, updated_at) VALUES (?, 'p1', ?, ?, ?)", [`t${i}`, `card ${i}`, STAMP, STAMP]);
    db.run("INSERT INTO topics (id, name, slug, session_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [`c${i}`, `topic ${i}`, `topic-${i}`, `key-${i}`, STAMP, STAMP]);
    for (let m = 0; m < 5; m++) db.run("INSERT INTO messages (session_key, role, timestamp) VALUES (?, 'user', ?)", [`key-${i}`, STAMP]);
  }
}

/** Every row of the three tables the switch counts, as one string. */
const dataDump = (db: Database) => JSON.stringify(["tasks", "messages", "topics"].map((t) => db.query(`SELECT * FROM ${t} ORDER BY rowid`).all()));

function startReplication(): void {
  mkdirSync(replicaDir(), { recursive: true });
  writeFileSync(configPath(), `dbs:\n  - path: ${livePath()}\n    replicas:\n      - url: file://${replicaDir()}\n        sync-interval: 100ms\n`);
  replicaProcess = Bun.spawn([REPLICA_BIN!, "replicate", "-config", configPath()], { stdout: "ignore", stderr: "ignore" });
}

/** `litestream restore` from the latest generation; null when the replica has nothing to restore. */
async function restoreLatest(name: string): Promise<string | null> {
  const out = join(root, name);
  const proc = Bun.spawn([REPLICA_BIN!, "restore", "-config", configPath(), "-o", out, livePath()], { stdout: "ignore", stderr: "ignore" });
  return (await proc.exited) === 0 && existsSync(out) ? out : null;
}

async function untilRestored(want: number, label: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const out = await restoreLatest(`${label}-${i}.db`);
    if (out) {
      const copy = new Database(out);
      try { if (copy.query("SELECT COUNT(*) AS n FROM messages").get() && countRows(copy).messages === want) return out; } catch { /* a restore of a half-written replica: poll again */ } finally { copy.close(); }
    }
    await sleep(100);
  }
  throw new Error(`the replica never reached ${want} messages`);
}

describe.skipIf(!REPLICA_BIN)("primary switch with a real Litestream on the live DB path", () => {
  test("the fence leaves the data to Litestream untouched, and a restore after the set-aside returns the DB handed over", async () => {
    const db = initDatabase(join(import.meta.dir, "..", ".."), root);
    seed(db);
    startReplication();
    const handedOver = countRows(db);
    await untilRestored(handedOver.messages, "warm");

    // The fence is up and Litestream keeps replicating: it writes its own tables, never the data.
    setPrimaryFence(FENCE);
    const before = dataDump(db);
    await sleep(1500);
    expect(dataDump(db)).toBe(before);
    expect(countRows(db)).toEqual(handedOver);
    const names = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '\\_litestream%' ESCAPE '\\' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).toEqual(["_litestream_lock", "_litestream_seq"]);
    expect(() => db.run("INSERT INTO messages (session_key, role, timestamp) VALUES ('key-0', 'user', ?)", [STAMP])).toThrow(/readonly/i);
    const replicated = await untilRestored(handedOver.messages, "fenced");
    expect(countRows(new Database(replicated))).toEqual(handedOver);

    // The restart after the commit: the boot sets the DB aside, the retired server opens its own DB and writes into it.
    closeDatabase();
    const appDataDir = join(root, "app-data");
    writeRetired(appDataDir, { ...FENCE, phase: "pending-set-aside" });
    bootPrimaryChange("", { stateDir: root, appDataDir, secretsDir: join(root, ".topics-secrets"), dbPath: livePath(), projectsDir: join(root, "claude-projects") });
    expect(existsSync(livePath())).toBe(false);
    const service = initDatabase(join(import.meta.dir, "..", ".."), root);
    service.run("INSERT INTO projects (id, name, slug, path, created_at, updated_at) VALUES ('svc', 'svc', 'svc', '/work/svc', ?, ?)", [STAMP, STAMP]);
    service.run("INSERT INTO topics (id, name, slug, session_key, created_at, updated_at) VALUES ('s1', 's', 's', 'k', ?, ?)", [STAMP, STAMP]);
    await sleep(2000);
    expect(existsSync(livePath())).toBe(false);
    expect(existsSync(join(dataDir(), RETIRED_DB_NAME))).toBe(true);

    replicaProcess?.kill();
    await replicaProcess?.exited;
    replicaProcess = null;
    const generations = readdirSync(join(replicaDir(), "generations"));
    expect(generations).toHaveLength(1);
    const restored = new Database((await restoreLatest("final.db"))!);
    expect(countRows(restored)).toEqual(handedOver);
    expect(restored.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    restored.close();
  }, 90_000);
});
