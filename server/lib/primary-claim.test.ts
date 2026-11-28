/**
 * @covers MACHINE-07
 *
 * `bun run primary claim` on a node whose primary died without warning (track
 * T9). The restore command is a stand-in that copies a DB file where the claim
 * asks (the real Litestream restore runs in `primary-claim-litestream.test.ts`);
 * everything after it is the real code: the copy's checks, the staged
 * manifest at epoch+1, and the boot that swaps it in and sets the node's own
 * DB aside as `topics.db.prima-<epoch>`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGE_IDENTITY_ENV, claimPrimary, type ClaimCommandRunner, type ClaimDeps, PRIMARY_ALIVE_WINDOW_MS, RESTORE_OUTPUT_ENV, runClaimCommand,
} from "./primary-claim";
import { createPrimaryRole, type PrimaryRole } from "./primary-role";
import { applyPendingPrimaryChange, DB_NAME, INCOMING_DIR, PRIMARY_STATE_FILE } from "./primary-switch";

const migration = readFileSync(join(import.meta.dir, "../db/migrations/20261118110000-primary-state.sql"), "utf-8");
const NOW = Date.parse("2026-11-28T12:00:00.000Z");
const IDENTITY = "AGE-SECRET-KEY-1TESTONLYNOTAREALKEY";
const roots: string[] = [];
const open: Database[] = [];

afterEach(() => {
  for (const db of open.splice(0)) { try { db.close(); } catch { /* closed by the test */ } }
  for (const r of roots.splice(0)) { try { rmSync(r, { recursive: true, force: true }); } catch { /* Windows may keep a file locked */ } }
});

/** A DB file shaped like the primary's, with `messages` rows and one card. */
function primaryDb(path: string, messages: number): void {
  const db = new Database(path);
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL);
    CREATE TABLE topics (id TEXT PRIMARY KEY);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL);`);
  db.exec(migration);
  db.query("INSERT INTO tasks VALUES ('t1', '2026-11-28T11:58:00.000Z')").run();
  for (let i = 0; i < messages; i++) db.query("INSERT INTO messages (timestamp) VALUES (?)").run(`2026-11-28T11:59:${String(i).padStart(2, "0")}.000Z`);
  db.close();
}

function node() {
  const root = mkdtempSync(join(tmpdir(), "primary-claim-"));
  roots.push(root);
  const stateDir = join(root, "state");
  const dataDir = join(stateDir, "data");
  const appDataDir = join(root, "app-data");
  for (const d of [dataDir, appDataDir]) mkdirSync(d, { recursive: true });
  const dbPath = join(dataDir, DB_NAME);
  // The node's own DB, as a secondary: it knows the dead primary at epoch 3.
  const db = new Database(dbPath);
  open.push(db);
  db.exec(migration);
  const role = createPrimaryRole({ db, stateFile: join(appDataDir, PRIMARY_STATE_FILE), localMachineId: () => "m-node", log: () => {} });
  role.adopt({ primaryMachineId: "m-mac", epoch: 3 });
  const replicaCopy = join(root, "replica.db");
  primaryDb(replicaCopy, 5);
  return { root, stateDir, appDataDir, dbPath, db, role, replicaCopy, secretsDir: join(stateDir, ".topics-secrets"), projectsDir: join(root, "projects") };
}
type Node = ReturnType<typeof node>;

/** The stand-in restore: copies the replica's DB where the claim asks, and records what it was given. */
function restoreFrom(source: string | null) {
  const calls: Array<{ command: string; env: Record<string, string> }> = [];
  const run: ClaimCommandRunner = (command, env) => {
    calls.push({ command, env });
    if (command === "channels") return null;
    if (source) copyFileSync(source, env[RESTORE_OUTPUT_ENV]!);
    return null;
  };
  return { calls, run };
}

function deps(n: Node, run: ClaimCommandRunner, over: Partial<ClaimDeps> = {}): ClaimDeps & { restarts: number } {
  const out = {
    role: n.role as Pick<PrimaryRole, "isPrimary" | "epoch" | "state">,
    localMachineId: "m-node",
    hostname: "node-host",
    stateDir: n.stateDir,
    receive: { secretsDir: n.secretsDir, appDataDir: n.appDataDir, dbPath: n.dbPath, projectsDir: n.projectsDir, replica: {}, holdersOf: () => [] },
    settings: { restore: "restore-latest", ageSecret: "replica/age-identity" },
    readSecret: async (name: string) => (name === "replica/age-identity" ? IDENTITY : null),
    lastHeardFromPrimary: () => NOW - 2 * PRIMARY_ALIVE_WINDOW_MS,
    force: false,
    run,
    now: () => NOW,
    log: () => {},
    restarts: 0,
    restart: () => { out.restarts++; },
    ...over,
  };
  return out;
}

describe("primary claim", () => {
  test("restores the replica at epoch+1; the boot swaps it in and sets the node's DB aside", async () => {
    const n = node();
    const { run, calls } = restoreFrom(n.replicaCopy);
    const d = deps(n, run);
    const report = await claimPrimary(d);
    expect(report).toMatchObject({ ok: true, outcome: "claimed", epoch: 4, counts: { tasks: 1, topics: 0, messages: 5 }, newestWrite: "2026-11-28T11:59:04.000Z" });
    expect(d.restarts).toBe(1);
    // The identity reaches the restore command in its environment only, never in the command line.
    expect(calls[0]!.env[AGE_IDENTITY_ENV]).toBe(IDENTITY);
    expect(calls[0]!.command).not.toContain(IDENTITY);
    expect(JSON.stringify(report)).not.toContain(IDENTITY);

    // The restart.
    n.db.close();
    if (process.platform === "win32") return; // Windows keeps the SQLite file locked after an in-process close.
    expect(applyPendingPrimaryChange({ ...n, replica: {}, holdersOf: () => [], log: () => {} })).toBe("restored");
    expect(existsSync(`${n.dbPath}.prima-4`)).toBe(true);
    const restored = new Database(n.dbPath, { readonly: true });
    open.push(restored);
    expect((restored.query("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c).toBe(5);
    expect(JSON.parse(readFileSync(join(n.appDataDir, PRIMARY_STATE_FILE), "utf-8"))).toMatchObject({ primaryMachineId: "m-node", epoch: 4 });
  });

  test("refused while this server is the primary, without a restore command, or with the primary heard from recently", async () => {
    const n = node();
    const { run, calls } = restoreFrom(n.replicaCopy);
    expect(await claimPrimary(deps(n, run, { settings: {} }))).toMatchObject({ ok: false, code: "no_restore_command" });
    expect(await claimPrimary(deps(n, run, { lastHeardFromPrimary: () => NOW - 60_000 }))).toMatchObject({ ok: false, code: "primary_alive" });
    expect(await claimPrimary(deps(n, run, { readSecret: async () => null }))).toMatchObject({ ok: false, code: "no_age_identity" });
    expect(calls).toHaveLength(0);
    // `--force` is the person saying the primary is dead after all.
    expect(await claimPrimary(deps(n, run, { lastHeardFromPrimary: () => NOW - 60_000, force: true }))).toMatchObject({ ok: true, epoch: 4 });

    const p = node();
    p.role.adopt({ primaryMachineId: "m-node", epoch: 4 });
    expect(await claimPrimary(deps(p, restoreFrom(p.replicaCopy).run))).toMatchObject({ ok: false, code: "already_primary" });
  });

  test("a restore that writes nothing or a corrupt copy is refused and leaves nothing staged", async () => {
    const n = node();
    const empty = deps(n, restoreFrom(null).run);
    expect(await claimPrimary(empty)).toMatchObject({ ok: false, code: "restore_empty" });
    const corrupt = join(n.root, "corrupt.db");
    writeFileSync(corrupt, "SQLite format 3\0 this is not a database");
    const bad = deps(n, restoreFrom(corrupt).run);
    expect(await claimPrimary(bad)).toMatchObject({ ok: false, code: "integrity" });
    expect(existsSync(join(n.stateDir, INCOMING_DIR))).toBe(false);
    expect(empty.restarts + bad.restarts).toBe(0);
    expect(n.role.epoch()).toBe(3);
  });

  test("a failing channels command is a warning, not a refusal", async () => {
    const n = node();
    const { run } = restoreFrom(n.replicaCopy);
    const d = deps(n, (command, env) => (command === "channels" ? "exit 1, signal null" : run(command, env)), { settings: { restore: "restore-latest", channels: "channels" } });
    const report = await claimPrimary(d);
    expect(report).toMatchObject({ ok: true, epoch: 4 });
    expect(report.ok && report.warning).toContain("channels command failed");
  });

  test("the real runner hands the identity to the command in its environment", () => {
    const root = mkdtempSync(join(tmpdir(), "primary-claim-run-"));
    roots.push(root);
    const out = join(root, "out.txt");
    const script = join(root, "write-env.js");
    writeFileSync(script, `require("fs").writeFileSync(process.env.${RESTORE_OUTPUT_ENV}, process.env.${AGE_IDENTITY_ENV} ?? "")`);
    // Not opening with a quote: `cmd /c` strips the outer pair of a line that starts with one.
    const failed = runClaimCommand(`cd "${root}" && "${process.execPath}" "${script}"`, { [RESTORE_OUTPUT_ENV]: out, [AGE_IDENTITY_ENV]: IDENTITY });
    expect(failed).toBeNull();
    expect(readFileSync(out, "utf-8")).toBe(IDENTITY);
    expect(runClaimCommand(`cd "${root}" && "${process.execPath}" -e "process.exit(4)"`, {})).toContain("exit 4");
  });
});
