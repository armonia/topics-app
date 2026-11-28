/**
 * @covers MACHINE-07
 *
 * A primary switch never leaves the installation with no primary, and never
 * replaces a DB under a replica it cannot stop.
 *
 *  - The receiver refuses BEFORE the commit, with the sender still the
 *    primary, when its DB is watched by a replica and the stop and start
 *    commands are not both set, or when a folder the restore writes into
 *    cannot be written.
 *  - At the receiver's boot a replica stop that fails throws before anything
 *    moves; a start that fails leaves the restore standing and comes back to
 *    the sender as the warning of its report.
 *  - The sender retires only once the receiver says it IS the primary. A
 *    restore that failed there is dropped, and the sender stays the primary.
 *
 * Two computers in one process: the real `runPrimarySwitch` on the sender, the
 * receiver's real commit and boot restore (`localReceiver`); only the
 * transport is a function call. The Litestream case with the real binary is in
 * `primary-switch-replica-swap.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrimaryRole } from "./primary-role";
import { localReceiver, type LocalReceiverOptions } from "./primary-switch-test-support";
import { DB_NAME, INCOMING_DIR, PRIMARY_STATE_FILE, readRestoreStatus, RETIRED_FILE, writeIncomingChunk } from "./primary-switch";
import { runPrimarySwitch } from "../services/primary-switch-run";

const roots: string[] = [];
const open: Database[] = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function computer(label: string) {
  const root = mkdtempSync(join(tmpdir(), `primary-confirm-${label}-`));
  roots.push(root);
  const stateDir = join(root, "state");
  const dataDir = join(stateDir, "data");
  const appDataDir = join(root, "app-data");
  const projectsDir = join(root, "claude-projects");
  for (const d of [dataDir, appDataDir, projectsDir]) mkdirSync(d, { recursive: true });
  return { root, stateDir, dataDir, appDataDir, projectsDir, dbPath: join(dataDir, DB_NAME), secretsDir: join(stateDir, ".topics-secrets") };
}
type Computer = ReturnType<typeof computer>;

/** A shell command that ends with this exit code, on every platform the shell runs on. */
const exitWith = (code: number) => `exit ${code}`;

async function attempt(receiverOpts: Partial<LocalReceiverOptions> & { abandon?: () => Promise<boolean> }, setup?: (from: Computer, to: Computer) => void) {
  const from = computer("from");
  const to = computer("to");
  const db = new Database(from.dbPath);
  open.push(db);
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY); CREATE TABLE topics (id TEXT PRIMARY KEY, session_key TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT); CREATE TABLE claude_code_sessions (session_key TEXT PRIMARY KEY, claude_session_id TEXT);`);
  db.exec(readFileSync(join(import.meta.dir, "../db/migrations/20261118110000-primary-state.sql"), "utf-8"));
  db.query("INSERT INTO messages (body) VALUES ('the data that moves')").run();
  // An attachment, so the restore writes into the receiver's media folder.
  mkdirSync(join(from.appDataDir, "media"), { recursive: true });
  writeFileSync(join(from.appDataDir, "media", "photo.png"), "pixels");
  // The receiver's own DB, which a refused or failed switch must leave as it was.
  writeFileSync(to.dbPath, "the receiver's own DB");
  setup?.(from, to);
  const role = createPrimaryRole({ db, stateFile: join(from.appDataDir, PRIMARY_STATE_FILE), localMachineId: () => "m-old", log: () => {} });
  role.adopt({ primaryMachineId: "m-old", epoch: 1 });
  const receiver = localReceiver(to, { hostname: "new-host", ...receiverOpts });
  let restarts = 0;
  const report = await runPrimarySwitch({
    db, stateDir: from.stateDir, secretsDir: from.secretsDir, appDataDir: from.appDataDir, projectsDir: from.projectsDir,
    dataDir: from.dataDir, role, localMachineId: "m-old", target: { id: "m-new", hostname: "new-host", name: "server" },
    drain: () => {}, undrain: () => {}, stillWorking: () => [], park: async () => {}, setFence: () => {},
    upload: async (name, offset, bytes) => { writeIncomingChunk(to.stateDir, name, offset, bytes); },
    commit: receiver.commit, confirm: receiver.confirm, abandon: receiverOpts.abandon ?? receiver.abandon,
    restartSelf: () => { restarts++; }, sleep: async () => {}, pollMs: 0, confirmTimeoutMs: 0, chunkBytes: 4096, log: () => {},
  });
  return { report, role, from, to, restarts: () => restarts };
}

/** The sender is still the primary, with nothing of the switch left on it. */
function senderStays(t: Awaited<ReturnType<typeof attempt>>) {
  expect(t.role.isPrimary()).toBe(true);
  expect(existsSync(join(t.from.appDataDir, RETIRED_FILE)), "no retired marker").toBe(false);
  expect(t.restarts()).toBe(0);
}

/** The receiver has its own DB and is not a primary. */
function receiverUntouched(to: Computer) {
  expect(readFileSync(to.dbPath, "utf-8")).toBe("the receiver's own DB");
  expect(existsSync(join(to.appDataDir, PRIMARY_STATE_FILE))).toBe(false);
  expect(existsSync(join(to.stateDir, INCOMING_DIR)), "nothing staged is kept").toBe(false);
}

describe("the receiver refuses before the commit", () => {
  test("a Litestream folder next to its DB and no replica commands: refused, the sender stays the primary", async () => {
    const t = await attempt({}, (_from, to) => { mkdirSync(join(to.dataDir, `.${DB_NAME}-litestream`)); });
    expect(t.report).toMatchObject({ ok: false, outcome: "refused", step: "commit" });
    expect(t.report.error).toContain("replica_unmanaged");
    senderStays(t);
    receiverUntouched(t.to);
  });

  test("another process holding its DB open and only the stop command set: refused", async () => {
    const t = await attempt({ holdersOf: () => [process.pid + 1], replica: { stop: exitWith(0) } });
    expect(t.report.error).toContain("replica_unmanaged");
    senderStays(t);
  });

  test("a folder the restore writes into that cannot be written: refused, the sender stays the primary", async () => {
    // The media folder is a file: nothing can be created below it, on every platform.
    const t = await attempt({}, (_from, to) => { writeFileSync(join(to.appDataDir, "media"), "not a folder"); });
    expect(t.report).toMatchObject({ ok: false, outcome: "refused", step: "commit" });
    expect(t.report.error).toContain("not_writable");
    senderStays(t);
    receiverUntouched(t.to);
  });
});

describe("the receiver's boot, after the commit", () => {
  test("a replica stop that fails: the DB is not replaced, the restore is dropped and the sender stays the primary", async () => {
    let booted: unknown = null;
    const t = await attempt(
      { replica: { stop: exitWith(3), start: exitWith(0) }, onBoot: (o) => { booted = o; } },
      (_from, to) => { mkdirSync(join(to.dataDir, `.${DB_NAME}-litestream`)); },
    );
    expect(String(booted)).toContain("the replica did not stop");
    expect(t.report).toMatchObject({ ok: false, outcome: "refused", step: "abandon" });
    expect(t.report.error).toContain("did not stop");
    senderStays(t);
    receiverUntouched(t.to);
    expect(readRestoreStatus(t.to.appDataDir), "the dropped restore leaves no status behind").toBeNull();
  });

  // A stop that only kills the replica under a supervisor that restarts it (launchd KeepAlive,
  // systemd Restart=) exits 0 while a new replica already holds the DB: the exit code is not trusted.
  test("a supervisor restarts the replica as soon as it is stopped: nothing moves, the sender stays the primary", async () => {
    let booted: unknown = null;
    const t = await attempt({
      holdersOf: () => [process.pid + 1], replica: { stop: exitWith(0), start: exitWith(0) }, onBoot: (o) => { booted = o; },
    });
    expect(String(booted)).toContain("after the replica stop command");
    expect(t.report).toMatchObject({ ok: false, outcome: "refused", step: "abandon" });
    senderStays(t);
    receiverUntouched(t.to);
    expect(existsSync(join(t.to.appDataDir, "media", "photo.png")), "no file of the bundle was placed").toBe(false);
  });

  test("a supervisor restarts the replica while the files are copied: the DB is not replaced, the sender stays the primary", async () => {
    let booted: unknown = null;
    const t = await attempt({
      // The replica comes back once the restore has started writing on the receiver.
      holdersOf: (path) => existsSync(join(path, "..", "..", "..", "app-data", "media", "photo.png")) ? [process.pid + 1] : [],
      replica: { stop: exitWith(0), start: exitWith(0) },
      onBoot: (o) => { booted = o; },
    }, (_from, to) => { mkdirSync(join(to.dataDir, `.${DB_NAME}-litestream`)); });
    expect(String(booted)).toContain("right before the DB is replaced");
    expect(t.report).toMatchObject({ ok: false, outcome: "refused", step: "abandon" });
    senderStays(t);
    receiverUntouched(t.to);
  });

  test("a replica start that fails: the switch stands, and the report says what the new primary needs", async () => {
    const t = await attempt({ replica: { stop: exitWith(0), start: exitWith(4) } });
    expect(t.report).toMatchObject({ ok: true, outcome: "switched" });
    expect(t.report.warning).toContain("did not start again");
    expect(t.role.isPrimary()).toBe(false);
    expect(readRestoreStatus(t.to.appDataDir)?.warning).toContain("did not start again");
  });

  test("a copy that fails at the restore: the sender does not retire, the restore is dropped and the sender stays the primary", async () => {
    // Writable at the commit, a file by the time the receiver restarts: the boot cannot copy the attachment.
    let to: Computer | null = null;
    const t = await attempt({
      beforeBoot: () => { rmSync(join(to!.appDataDir, "media"), { recursive: true, force: true }); writeFileSync(join(to!.appDataDir, "media"), "not a folder"); },
    }, (_from, receiver) => { to = receiver; });
    expect(t.report).toMatchObject({ ok: false, outcome: "refused", step: "abandon" });
    senderStays(t);
    expect(readFileSync(t.to.dbPath, "utf-8")).toBe("the receiver's own DB");
    expect(existsSync(join(t.to.appDataDir, PRIMARY_STATE_FILE))).toBe(false);
    expect(existsSync(join(t.to.stateDir, INCOMING_DIR)), "the dropped copy is gone, so no later boot restores it").toBe(false);
  });

  test("a failed restore the receiver does not drop: uncertain, fenced, never two primaries", async () => {
    let to: Computer | null = null;
    const t = await attempt({
      beforeBoot: () => { rmSync(join(to!.appDataDir, "media"), { recursive: true, force: true }); writeFileSync(join(to!.appDataDir, "media"), "not a folder"); },
      abandon: async () => false,
    }, (_from, receiver) => { to = receiver; });
    expect(t.report).toMatchObject({ ok: false, outcome: "uncertain" });
    expect(t.role.isPrimary()).toBe(false);
  });

  test("a receiver that never confirms: uncertain, the sender does not retire as if it had", async () => {
    const never = await (async () => {
      const from = computer("silent");
      const db = new Database(from.dbPath);
      open.push(db);
      db.exec(`CREATE TABLE tasks (id TEXT); CREATE TABLE topics (id TEXT, session_key TEXT); CREATE TABLE messages (id INTEGER);
        CREATE TABLE claude_code_sessions (session_key TEXT, claude_session_id TEXT);`);
      db.exec(readFileSync(join(import.meta.dir, "../db/migrations/20261118110000-primary-state.sql"), "utf-8"));
      const role = createPrimaryRole({ db, stateFile: join(from.appDataDir, PRIMARY_STATE_FILE), localMachineId: () => "m-old", log: () => {} });
      role.adopt({ primaryMachineId: "m-old", epoch: 1 });
      let restarts = 0;
      const report = await runPrimarySwitch({
        db, stateDir: from.stateDir, secretsDir: from.secretsDir, appDataDir: from.appDataDir, projectsDir: from.projectsDir,
        dataDir: from.dataDir, role, localMachineId: "m-old", target: { id: "m-new", hostname: "new-host", name: "server" },
        drain: () => {}, undrain: () => {}, stillWorking: () => [], park: async () => {}, setFence: () => {},
        upload: async () => {}, commit: async (m) => ({ kind: "accepted", counts: m.counts }),
        confirm: async () => ({ kind: "waiting" }), abandon: async () => true,
        restartSelf: () => { restarts++; }, sleep: async () => {}, pollMs: 0, confirmTimeoutMs: 0, log: () => {},
      });
      return { report, role, restarts };
    })();
    expect(never.report).toMatchObject({ ok: false, outcome: "uncertain", step: "confirm" });
    expect(never.role.isPrimary()).toBe(false);
    expect(never.restarts).toBe(0);
  });
});
