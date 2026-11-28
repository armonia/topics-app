/**
 * @covers MACHINE-07
 *
 * A replica of the live DB path (Litestream) across the REPLACEMENT of the DB
 * file on the computer that receives the primary. The REAL `litestream` binary
 * runs on throwaway DBs in a temp folder, with a `file://` replica, never the
 * production config; the test launches the process itself and the configured
 * stop and start commands (`TOPICS_REPLICA_STOP_COMMAND` / `_START_COMMAND`)
 * manage it. Skipped when `litestream` is not in PATH.
 *
 * Why the commands exist: Litestream keeps the old DB file open. Renamed under
 * it, it publishes a generation made of the old DB's snapshot and the new
 * file's WAL, `litestream restore` fails ("database disk image is malformed")
 * and every later sync stops, with the process still alive.
 *
 * The round trip: A hands its DB to B (B replaces its file), B takes a write
 * and hands it back to A (A replaces its file). After each replacement the
 * replica of the receiver restores with exit 0 and the counts of what arrived.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPendingPrimaryChange, commitIncoming, countRows, DB_NAME, type ReplicaCommands, replicaCommandsFromEnv,
  REPLICA_START_ENV, REPLICA_STOP_ENV, snapshotDatabase, writeIncomingChunk,
} from "./primary-switch";

const REPLICA_BIN = Bun.which("litestream");
const migration = readFileSync(join(import.meta.dir, "../db/migrations/20261118110000-primary-state.sql"), "utf-8");
const roots: string[] = [];
const open: Database[] = [];
const pidFiles: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

afterEach(() => {
  for (const db of open.splice(0)) { try { db.close(); } catch { /* already closed by the test */ } }
  // Only the processes this test started: each pid file is its own, in a temp folder.
  for (const f of pidFiles.splice(0)) {
    try { process.kill(Number(readFileSync(f, "utf-8").trim()), "SIGKILL"); } catch { /* already gone */ }
  }
  for (const r of roots.splice(0)) { try { rmSync(r, { recursive: true, force: true }); } catch { /* temp dir cleanup only */ } }
});

/** One computer: its state folder, its live DB path, and the replica of that path managed by two shell commands. */
function computer(label: string) {
  const root = mkdtempSync(join(tmpdir(), `primary-replica-${label}-`));
  roots.push(root);
  const stateDir = join(root, "state");
  const appDataDir = join(root, "app-data");
  const dbPath = join(stateDir, "data", DB_NAME);
  mkdirSync(join(stateDir, "data"), { recursive: true });
  mkdirSync(appDataDir, { recursive: true });
  const replicaDir = join(root, "replica");
  const config = join(root, "litestream.yml");
  const pidFile = join(root, "litestream.pid");
  pidFiles.push(pidFile);
  mkdirSync(replicaDir, { recursive: true });
  writeFileSync(config, `dbs:\n  - path: ${dbPath}\n    replicas:\n      - url: file://${replicaDir}\n        sync-interval: 100ms\n`);
  const env: NodeJS.ProcessEnv = {
    [REPLICA_STOP_ENV]: `PID=$(cat ${quote(pidFile)}) && kill "$PID" && while kill -0 "$PID" 2>/dev/null; do sleep 0.1; done`,
    // Like `systemctl start` on a service that already runs: nothing happens, so only a real stop lets it take the new file.
    [REPLICA_START_ENV]: `if kill -0 "$(cat ${quote(pidFile)} 2>/dev/null)" 2>/dev/null; then exit 3; fi; nohup ${quote(REPLICA_BIN!)} replicate -config ${quote(config)} >/dev/null 2>&1 & echo $! > ${quote(pidFile)}`,
  };
  return { root, stateDir, appDataDir, dbPath, config, replicaDir, env, secretsDir: join(stateDir, ".topics-secrets"), projectsDir: join(root, "claude-projects") };
}
type Computer = ReturnType<typeof computer>;

function openDb(path: string): Database {
  const db = new Database(path);
  open.push(db);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE IF NOT EXISTS topics (id TEXT PRIMARY KEY, session_key TEXT);
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, topic_id TEXT, body TEXT);
    CREATE TABLE IF NOT EXISTS claude_code_sessions (session_key TEXT PRIMARY KEY, claude_session_id TEXT);`);
  db.exec(migration);
  return db;
}

function fill(db: Database, label: string, messages: number): void {
  db.query("INSERT INTO topics (id, session_key) VALUES (?, ?)").run(`topic-${label}`, `topic:${label}`);
  db.query("INSERT INTO tasks (id, title) VALUES (?, ?)").run(`task-${label}`, `card ${label}`);
  for (let i = 0; i < messages; i++) db.query("INSERT INTO messages (topic_id, body) VALUES (?, ?)").run(`topic-${label}`, `${label} message ${i}`);
}

/** The replica of this computer, started the way the setting says (what the receiver's boot does after the swap). */
function startReplica(c: Computer): void {
  const commands = replicaCommandsFromEnv(c.env);
  expect(spawnSync("sh", ["-c", commands.start!], { stdio: "ignore" }).status).toBe(0);
}

async function restoreFrom(c: Computer, name: string): Promise<{ status: number | null; path: string }> {
  const out = join(c.root, name);
  const proc = Bun.spawn([REPLICA_BIN!, "restore", "-config", c.config, "-o", out, c.dbPath], { stdout: "ignore", stderr: "ignore" });
  return { status: await proc.exited, path: out };
}

/** Polls `litestream restore` until the latest replica holds `want` messages: a replica that stopped never gets there. */
async function untilRestored(c: Computer, want: number, label: string): Promise<RestoredCounts> {
  let last = "no restore yet";
  for (let i = 0; i < 80; i++) {
    const { status, path } = await restoreFrom(c, `${label}-${i}.db`);
    if (status === 0 && existsSync(path)) {
      const copy = new Database(path);
      try {
        const counts = countRows(copy);
        if (counts.messages === want) return { counts, integrity: copy.query("PRAGMA integrity_check").all() as Array<{ integrity_check: string }> };
        last = `restored ${counts.messages} messages`;
      } catch (err) { last = String(err); } finally { copy.close(); }
    } else last = `litestream restore exited ${status}`;
    await sleep(150);
  }
  throw new Error(`the replica of ${label} never restored with ${want} messages (${last})`);
}
type RestoredCounts = { counts: ReturnType<typeof countRows>; integrity: Array<{ integrity_check: string }> };

/** The old primary hands its live DB to `to`: snapshot, stage, commit, then the receiver's boot applies it. */
async function handOver(db: Database, from: Computer, to: Computer, epoch: number, replica: ReplicaCommands | undefined): Promise<void> {
  const copy = join(from.stateDir, "outgoing", DB_NAME);
  const counts = snapshotDatabase(db, copy);
  const bytes = new Uint8Array(readFileSync(copy));
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  writeIncomingChunk(to.stateDir, DB_NAME, 0, bytes);
  const verdict = await commitIncoming(to.stateDir, {
    version: 1, epoch, toMachineId: "m-to", toHostname: "to-host", fromMachineId: "m-from", createdAt: "2026-01-01T00:00:00.000Z",
    counts, files: [{ name: DB_NAME, size: bytes.byteLength, sha256 }],
  }, { hostname: "to-host", epoch: epoch - 1, freeBytes: () => Number.MAX_SAFE_INTEGER });
  expect(verdict.ok).toBe(true);
  expect(applyPendingPrimaryChange({
    stateDir: to.stateDir, secretsDir: to.secretsDir, dbPath: to.dbPath, appDataDir: to.appDataDir, projectsDir: to.projectsDir,
    replica, log: () => {},
  })).toBe("restored");
}

describe.skipIf(!REPLICA_BIN)("primary switch with a real Litestream on the receiving computer", () => {
  test("round trip A to B and back: the replica of the receiver restores with exit 0 after each swap", async () => {
    const a = computer("a");
    const b = computer("b");

    const dbA = openDb(a.dbPath);
    fill(dbA, "a", 40);
    const dbB = openDb(b.dbPath);
    fill(dbB, "b", 10);
    startReplica(a);
    startReplica(b);
    await untilRestored(a, 40, "a-warm");
    await untilRestored(b, 10, "b-warm");

    // A to B: B closes its DB (the restart), the boot replaces the file with its replica stopped and started around it.
    const handedToB = countRows(dbA);
    dbB.close();
    await handOver(dbA, a, b, 2, replicaCommandsFromEnv(b.env));
    const restoredB = await untilRestored(b, handedToB.messages, "b-after-swap");
    expect(restoredB.counts).toEqual(handedToB);
    expect(restoredB.integrity).toEqual([{ integrity_check: "ok" }]);

    // B is the primary now and takes a write; the replica follows the new file, not the one set aside.
    const newB = openDb(b.dbPath);
    for (let i = 0; i < 5; i++) newB.query("INSERT INTO messages (topic_id, body) VALUES ('topic-a', ?)").run(`written on b ${i}`);
    const handedBack = countRows(newB);
    expect(handedBack.messages).toBe(handedToB.messages + 5);
    await untilRestored(b, handedBack.messages, "b-written");

    // B hands it back to A: the same swap on A, whose Litestream was running on the old file all along.
    dbA.close();
    await handOver(newB, b, a, 3, replicaCommandsFromEnv(a.env));
    const restoredA = await untilRestored(a, handedBack.messages, "a-after-return");
    expect(restoredA.counts).toEqual(handedBack);
    expect(restoredA.integrity).toEqual([{ integrity_check: "ok" }]);
  }, 120_000);
});
