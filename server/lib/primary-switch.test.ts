/**
 * @covers MACHINE-06
 * The bar of track T4: a primary moves to another computer and nothing is lost.
 * Two computers in one process, each with its own state dir, app data dir and
 * CLI projects folder; the transport is the receiver's own staging functions.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrimaryRole } from "./primary-role";
import { retiredRefusal, setPrimaryFence } from "./primary-fence";
import {
  applyPendingPrimaryChange, commitIncoming, countRows, DB_NAME, INCOMING_DIR, isRefusedWhenRetired,
  isSafeBundleName, MOVED_CODE, readRetired, RETIRED_FILE, type RetiredState, writeIncomingChunk,
} from "./primary-switch";
import { findCliTranscript } from "./subagent-migration";
import { PARK_NOTE, runPrimarySwitch, type PrimarySwitchDeps, type WorkInFlight } from "../services/primary-switch-run";

const migration = readFileSync(join(import.meta.dir, "../db/migrations/20261118110000-primary-state.sql"), "utf-8");
const SESSION = "0b7c2a52-6d1e-4a3f-9b58-1f2e3d4c5b6a";
const roots: string[] = [];
const open: Database[] = [];

afterEach(() => {
  // Closed before the folders go: Windows refuses to remove an open DB file.
  for (const db of open.splice(0)) db.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function computer(label: string) {
  const root = mkdtempSync(join(tmpdir(), `primary-switch-${label}-`));
  roots.push(root);
  const stateDir = join(root, "state");
  const appDataDir = join(root, "app-data");
  const projectsDir = join(root, "claude-projects");
  const dbPath = join(stateDir, "data", DB_NAME);
  mkdirSync(join(stateDir, "data"), { recursive: true });
  mkdirSync(appDataDir, { recursive: true });
  mkdirSync(projectsDir, { recursive: true });
  return { root, stateDir, appDataDir, projectsDir, dbPath };
}

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

/** The old primary: a live DB with a topic bound to a CLI session whose transcript is on disk. */
function oldPrimary() {
  const c = computer("old");
  const db = openDb(c.dbPath);
  for (let i = 0; i < 5; i++) db.query("INSERT INTO tasks (id, title) VALUES (?, ?)").run(`t${i}`, `card ${i}`);
  db.query("INSERT INTO topics (id, session_key) VALUES ('topic-1', 'topic:topic-1')").run();
  for (let i = 0; i < 7; i++) db.query("INSERT INTO messages (topic_id, body) VALUES ('topic-1', ?)").run(`message ${i}`);
  db.query("INSERT INTO claude_code_sessions VALUES ('topic:topic-1', ?)").run(SESSION);
  const projectFolder = join(c.projectsDir, "-src-project");
  mkdirSync(join(projectFolder, SESSION, "subagents"), { recursive: true });
  writeFileSync(join(projectFolder, `${SESSION}.jsonl`), '{"type":"user","message":{"content":"the context so far"}}\n');
  writeFileSync(join(projectFolder, SESSION, "subagents", "agent-1.jsonl"), '{"type":"assistant"}\n');
  mkdirSync(join(c.stateDir, "nodes"), { recursive: true });
  writeFileSync(join(c.stateDir, "nodes", "m-new.token"), "node-token-value\n");
  writeFileSync(join(c.stateDir, "nodes", "m-new.model-token.sha256"), "hash\n");
  writeFileSync(join(c.stateDir, "license-token"), "licence\n");
  writeFileSync(join(c.stateDir, "installation-id"), "install-1\n");
  const role = createPrimaryRole({ db, stateFile: join(c.appDataDir, "primary-state.json"), localMachineId: () => "m-old", log: () => {} });
  role.adopt({ primaryMachineId: "m-old", epoch: 1 });
  return { ...c, db, role };
}

function harness(overrides: Partial<PrimarySwitchDeps> = {}) {
  const old = oldPrimary();
  const neu = computer("new");
  const before = countRows(old.db);
  let fence: RetiredState | null = null;
  let restarts = 0;
  const parkedNotes: string[] = [];
  let busy: WorkInFlight[] = [{ taskId: "t1", sessionKey: "topic:card-1" }];
  let polls = 0;
  const deps: PrimarySwitchDeps = {
    db: old.db,
    stateDir: old.stateDir,
    appDataDir: old.appDataDir,
    projectsDir: old.projectsDir,
    role: old.role,
    localMachineId: "m-old",
    target: { id: "m-new", hostname: "new-host", name: "server" },
    drain: () => {},
    undrain: () => {},
    stillWorking: () => {
      // The card still running writes its last message during the drain, then finishes.
      if (polls++ === 1) {
        old.db.query("INSERT INTO messages (topic_id, body) VALUES ('topic-1', 'written during the drain')").run();
        busy = [];
      }
      return busy;
    },
    park: async (work, note) => { parkedNotes.push(`${work.taskId}:${note}`); },
    setFence: (s) => { fence = s; },
    upload: async (name, offset, bytes) => { writeIncomingChunk(neu.stateDir, name, offset, bytes); },
    commit: async (manifest) => {
      const v = await commitIncoming(neu.stateDir, manifest, { hostname: "new-host", epoch: 0 });
      return v.ok ? { kind: "accepted", counts: v.counts } : { kind: "refused", code: v.code, error: v.error };
    },
    restartSelf: () => { restarts++; },
    sleep: async () => {},
    pollMs: 0,
    chunkBytes: 4096,
    log: () => {},
    ...overrides,
  };
  return { old, neu, before, deps, fence: () => fence, restarts: () => restarts, parkedNotes };
}

describe("primary switch", () => {
  test("moves the DB, the state and the transcripts; counts equal, the drain write is there", async () => {
    const h = harness();
    const report = await runPrimarySwitch(h.deps);
    expect(report.outcome).toBe("switched");
    expect(report.epoch).toBe(2);
    expect(h.restarts()).toBe(1);

    // The receiver restarts: the boot hook puts the shipped DB in place.
    expect(applyPendingPrimaryChange({ ...h.neu, log: () => {} })).toBe("restored");
    const restored = new Database(h.neu.dbPath, { readonly: true });
    const after = countRows(restored);
    expect(after).toEqual({ ...h.before, messages: h.before.messages + 1 });
    expect(after).toEqual(report.counts!);
    expect(restored.query("SELECT 1 FROM messages WHERE body = 'written during the drain'").get()).not.toBeNull();

    // The new computer boots as the primary at epoch+1.
    const role = createPrimaryRole({ db: restored as unknown as Database, stateFile: join(h.neu.appDataDir, "primary-state.json"), localMachineId: () => "m-new", log: () => {} });
    expect(role.isPrimary()).toBe(true);
    expect(role.epoch()).toBe(2);
    restored.close();

    // State files followed; the transcript resumes by id with its content and its subagents.
    expect(readFileSync(join(h.neu.stateDir, "nodes", "m-new.token"), "utf-8")).toBe("node-token-value\n");
    expect(readFileSync(join(h.neu.stateDir, "license-token"), "utf-8")).toBe("licence\n");
    const transcript = findCliTranscript(SESSION, h.neu.projectsDir);
    expect(transcript).not.toBeNull();
    expect(readFileSync(transcript!, "utf-8")).toContain("the context so far");
    expect(existsSync(join(h.neu.projectsDir, "-src-project", SESSION, "subagents", "agent-1.jsonl"))).toBe(true);
    expect(existsSync(join(h.neu.stateDir, INCOMING_DIR))).toBe(false);
  });

  test("the old primary refuses writes after the switch, and its boot sets the DB aside", async () => {
    const h = harness();
    await runPrimarySwitch(h.deps);
    expect(h.old.role.isPrimary()).toBe(false);
    const fence = h.fence();
    expect(fence?.epoch).toBe(2);
    // The front door refuses a client write with this answer while the fence is up.
    setPrimaryFence(fence);
    try {
      const refused = retiredRefusal("/api/tasks", "POST");
      expect(refused?.status).toBe(409);
      expect((await refused!.json() as { code: string }).code).toBe(MOVED_CODE);
      expect(retiredRefusal("/api/tasks", "GET")).toBeNull();
    } finally {
      setPrimaryFence(null);
    }
    expect(retiredRefusal("/api/tasks", "POST")).toBeNull();
    expect(readRetired(h.old.appDataDir)?.pendingSetAside).toBe(true);

    h.old.db.close();
    expect(applyPendingPrimaryChange({ ...h.old, log: () => {} })).toBe("set-aside");
    expect(existsSync(h.old.dbPath)).toBe(false);
    expect(existsSync(`${h.old.dbPath}.prima-2`)).toBe(true);
    expect(existsSync(join(h.old.stateDir, "nodes"))).toBe(false);
    expect(existsSync(join(h.old.stateDir, "license-token.prima-2"))).toBe(true);
    // After its own restart it still refuses: the marker stays, only the pending flag goes.
    expect(readRetired(h.old.appDataDir)).toMatchObject({ epoch: 2, toMachineId: "m-new", pendingSetAside: false });
    expect(applyPendingPrimaryChange({ ...h.old, log: () => {} })).toBeNull();
  });

  test("the front door asks the fence before the access gate", () => {
    const src = readFileSync(join(import.meta.dir, "../routes/front-door.ts"), "utf-8");
    const fence = src.indexOf("const moved = retiredRefusal(pathname, method);\n      if (moved) return moved;");
    expect(fence).toBeGreaterThan(0);
    expect(fence).toBeLessThan(src.indexOf("const refused = accessGate("));
  });

  test("reads and the node and pairing routes stay open on a retired server", () => {
    expect(isRefusedWhenRetired("/api/tasks", "GET")).toBe(false);
    expect(isRefusedWhenRetired("/api/nodes/primary/commit", "POST")).toBe(false);
    expect(isRefusedWhenRetired("/api/auth/pair/request", "POST")).toBe(false);
    expect(isRefusedWhenRetired("/api/topics/x/messages", "DELETE")).toBe(true);
  });

  test("work still running when the drain is over is parked with a note", async () => {
    const h = harness({ stillWorking: () => [{ taskId: "t3", sessionKey: "topic:card-3" }], drainTimeoutMs: 0 });
    const report = await runPrimarySwitch(h.deps);
    expect(report.outcome).toBe("switched");
    expect(report.parked).toEqual(["t3"]);
    expect(h.parkedNotes).toEqual([`t3:${PARK_NOTE}`]);
  });

  test("a refused commit undoes everything and the old stays the primary", async () => {
    let undrained = 0;
    const h = harness({
      commit: async () => ({ kind: "refused", code: "wrong_machine", error: "not me" }),
      undrain: () => { undrained++; },
    });
    const report = await runPrimarySwitch(h.deps);
    expect(report.outcome).toBe("refused");
    expect(h.fence()).toBeNull();
    expect(undrained).toBe(1);
    expect(h.old.role.isPrimary()).toBe(true);
    expect(h.old.role.epoch()).toBe(1);
    expect(existsSync(join(h.old.appDataDir, RETIRED_FILE))).toBe(false);
    expect(h.restarts()).toBe(0);
  });

  test("a commit without an answer stays fenced: never two primaries", async () => {
    const h = harness({ commit: async () => ({ kind: "unknown", error: "socket closed" }) });
    const report = await runPrimarySwitch(h.deps);
    expect(report.outcome).toBe("uncertain");
    expect(h.fence()).not.toBeNull();
    expect(h.restarts()).toBe(0);
  });

  test("the receiver refuses a bundle for another computer, a stale epoch or a tampered file", async () => {
    const h = harness({ commit: async (manifest) => {
      for (const [local, code] of [[{ hostname: "other", epoch: 0 }, "wrong_machine"], [{ hostname: "new-host", epoch: 2 }, "stale_epoch"]] as const) {
        const v = await commitIncoming(h.neu.stateDir, manifest, local);
        expect(v.ok ? "ok" : v.code).toBe(code);
      }
      writeFileSync(join(h.neu.stateDir, INCOMING_DIR, "license-token-x"), "");
      const tampered = { ...manifest, files: manifest.files.map((f) => f.name === "state/license-token" ? { ...f, sha256: "0".repeat(64) } : f) };
      const v = await commitIncoming(h.neu.stateDir, tampered, { hostname: "new-host", epoch: 0 });
      expect(v.ok ? "ok" : v.code).toBe("hash_mismatch");
      return { kind: "refused", code: "test", error: "checked" };
    } });
    const report = await runPrimarySwitch(h.deps);
    expect(report.outcome).toBe("refused");
    expect(applyPendingPrimaryChange({ ...h.neu, log: () => {} })).toBeNull();
  });

  test("bundle names cannot leave the staging folder, chunks cannot overlap", () => {
    for (const bad of ["../x", "state/../../etc", "/abs", "state/", "other/file", "transcripts/a//b", "state/a\\b"]) {
      expect(isSafeBundleName(bad)).toBe(false);
    }
    expect(isSafeBundleName("transcripts/-src-project/x.jsonl")).toBe(true);
    const c = computer("chunks");
    writeIncomingChunk(c.stateDir, "state/license-token", 0, new Uint8Array([1, 2]));
    expect(() => writeIncomingChunk(c.stateDir, "state/license-token", 0 + 1, new Uint8Array([3]))).toThrow();
    expect(writeIncomingChunk(c.stateDir, "state/license-token", 2, new Uint8Array([3]))).toBe(3);
  });
});
