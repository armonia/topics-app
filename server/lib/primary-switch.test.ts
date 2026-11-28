/**
 * @covers MACHINE-07
 * The bar of track T4: a primary moves to another computer and nothing is lost.
 * Two computers in one process, each with its own state dir, app data dir and
 * CLI projects folder; the transport is the receiver's own staging functions.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrimaryRole, isThisServerPrimary } from "./primary-role";
import { localReceiver } from "./primary-switch-test-support";
import { bootPrimaryChange, gatedRefusal, holdRetiredRole, reclaimPrimary, retiredRefusal, setPrimaryFence } from "./primary-fence";
import {
  applyPendingPrimaryChange, commitIncoming, countRows, DB_NAME, INCOMING_DIR, isRefusedWhenRetired,
  isSafeBundleName, MOVED_CODE, OUTGOING_DIR, readRetired, RETIRED_FILE, type RetiredState, writeIncomingChunk,
} from "./primary-switch";
import { caricaChiavi, verificaGettone } from "./licenza";
import { leggiInstallationId } from "../services/relay-config";
import { encryptedChannelError } from "../routes/primary-switch-trigger";
import { findCliTranscript } from "./subagent-migration";
import { PARK_NOTE, runPrimarySwitch, type PrimarySwitchDeps, type WorkInFlight } from "../services/primary-switch-run";

const migration = readFileSync(join(import.meta.dir, "../db/migrations/20261118110000-primary-state.sql"), "utf-8");
const SESSION = "0b7c2a52-6d1e-4a3f-9b58-1f2e3d4c5b6a";
const roots: string[] = [];
const open: Database[] = [];

afterEach(() => {
  setPrimaryFence(null);
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
  // What `resolveSecretsDir` answers in a test process.
  const secretsDir = join(stateDir, ".topics-secrets");
  mkdirSync(join(stateDir, "data"), { recursive: true });
  mkdirSync(appDataDir, { recursive: true });
  mkdirSync(projectsDir, { recursive: true });
  return { root, stateDir, appDataDir, projectsDir, dbPath, secretsDir };
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

const licenseKeys = generateKeyPairSync("ed25519");
const licenseKeyB64 = (() => {
  const publicKeyBytes = licenseKeys.publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return publicKeyBytes.subarray(publicKeyBytes.length - 32).toString("base64");
})();

/** A licence token signed for one installation, the same shape the billing service mints. */
function signedLicense(installationId: string): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, iid: installationId, plan: "team", seats: 5, exp: 4_000_000_000_000 }), "utf8").toString("base64url");
  return `${payload}.${sign(null, Buffer.from(payload, "ascii"), licenseKeys.privateKey).toString("base64url")}`;
}

const roleOf = (db: Database, appDataDir: string, machineId: string) =>
  createPrimaryRole({ db, stateFile: join(appDataDir, "primary-state.json"), localMachineId: () => machineId, log: () => {} });

const mode = (path: string) => statSync(path).mode & 0o777;
/** File modes mean nothing on Windows: there the mode checks are skipped, not faked green. */
const ownerModeTest = process.platform === "win32" ? test.skip : test;

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
  writeFileSync(join(c.stateDir, "nodes", "m-new.token"), "node-token-value\n", { mode: 0o600 });
  writeFileSync(join(c.stateDir, "nodes", "m-new.model-token.sha256"), "hash\n", { mode: 0o600 });
  // The real writer of the installation id: it lands in the secrets folder, as in production.
  const installationId = leggiInstallationId(c.stateDir);
  writeFileSync(join(c.stateDir, "license-token"), signedLicense(installationId) + "\n");
  const role = roleOf(db, c.appDataDir, "m-old");
  role.adopt({ primaryMachineId: "m-old", epoch: 1 });
  return { ...c, db, role, installationId };
}

function harness(overrides: Partial<PrimarySwitchDeps> = {}) {
  const old = oldPrimary();
  const receiver = computer("new");
  // The receiver already has an installation id of its own: the old one must replace it.
  const receiverOwnId = leggiInstallationId(receiver.stateDir);
  const before = countRows(old.db);
  let fence: RetiredState | null = null;
  let restarts = 0;
  const parkedNotes: string[] = [];
  let busy: WorkInFlight[] = [{ taskId: "t1", sessionKey: "topic:card-1" }];
  let polls = 0;
  const deps: PrimarySwitchDeps = {
    db: old.db,
    stateDir: old.stateDir,
    secretsDir: old.secretsDir,
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
    // The real fence, so every check below asks what the front door would ask.
    setFence: (s) => { fence = s; setPrimaryFence(s); },
    upload: async (name, offset, bytes) => { writeIncomingChunk(receiver.stateDir, name, offset, bytes); },
    ...localReceiver(receiver, { hostname: "new-host" }),
    // The fake sleep makes the wait a spin: a receiver that never restores gives up at the first look.
    confirmTimeoutMs: 0,
    restartSelf: () => { restarts++; },
    sleep: async () => {},
    pollMs: 0,
    chunkBytes: 4096,
    log: () => {},
    ...overrides,
  };
  return { old, receiver, before, deps, fence: () => fence, restarts: () => restarts, parkedNotes, receiverOwnId };
}

/** A boot of `c`: the pending change runs before the DB opens, then the role is read and held. */
function reboot(c: ReturnType<typeof computer>, machineId: string) {
  bootPrimaryChange("", { stateDir: c.stateDir, appDataDir: c.appDataDir, secretsDir: c.secretsDir, dbPath: c.dbPath, projectsDir: c.projectsDir });
  const db = new Database(c.dbPath);
  open.push(db);
  db.exec(migration);
  const role = roleOf(db, c.appDataDir, machineId);
  holdRetiredRole(role, () => {});
  return { db, role };
}

describe("primary switch", () => {
  test("moves the DB, the state and the transcripts; counts equal, the drain write is there", async () => {
    const h = harness();
    const report = await runPrimarySwitch(h.deps);
    expect(report.outcome, report.error).toBe("switched");
    expect(report.epoch).toBe(2);
    expect(h.restarts()).toBe(1);

    // The receiver restarts: the boot hook puts the shipped DB in place.
    const receiver = reboot(h.receiver, "m-new");
    const after = countRows(receiver.db);
    expect(after).toEqual({ ...h.before, messages: h.before.messages + 1 });
    expect(after).toEqual(report.counts!);
    expect(receiver.db.query("SELECT 1 FROM messages WHERE body = 'written during the drain'").get()).not.toBeNull();

    // The new computer boots as the primary at epoch+1.
    expect(receiver.role.isPrimary()).toBe(true);
    expect(receiver.role.epoch()).toBe(2);

    // State files followed; the transcript resumes by id with its content and its subagents.
    expect(readFileSync(join(h.receiver.stateDir, "nodes", "m-new.token"), "utf-8")).toBe("node-token-value\n");
    const transcript = findCliTranscript(SESSION, h.receiver.projectsDir);
    expect(transcript).not.toBeNull();
    expect(readFileSync(transcript!, "utf-8")).toContain("the context so far");
    expect(existsSync(join(h.receiver.projectsDir, "-src-project", SESSION, "subagents", "agent-1.jsonl"))).toBe(true);
    expect(existsSync(join(h.receiver.stateDir, INCOMING_DIR))).toBe(false);
  });

  test("the licence still verifies on the new primary: the installation id followed it", async () => {
    const h = harness();
    expect(h.receiverOwnId).not.toBe(h.old.installationId);
    await runPrimarySwitch(h.deps);
    reboot(h.receiver, "m-new");
    const id = leggiInstallationId(h.receiver.stateDir);
    expect(id).toBe(h.old.installationId);
    const license = verificaGettone(readFileSync(join(h.receiver.stateDir, "license-token"), "utf-8"), {
      chiavi: caricaChiavi({ TOPICS_LICENSE_PUBKEYS: `k1:${licenseKeyB64}` }, []), installationId: id, ora: 1_000,
    });
    expect(license.motivo).not.toBe("other_installation");
    expect(license.piano).toBe("team");
  });

  ownerModeTest("secrets are owner-only at every stage: outgoing copy, staging, restored files", async () => {
    const seen: Record<string, number> = {};
    const h = harness();
    const upload = h.deps.upload;
    h.deps.upload = async (name, offset, bytes) => {
      if (name === DB_NAME && offset === 0) seen.outgoingDb = mode(join(h.old.stateDir, OUTGOING_DIR, DB_NAME));
      await upload(name, offset, bytes);
      seen[`staged:${name}`] = mode(join(h.receiver.stateDir, INCOMING_DIR, ...name.split("/")));
      seen.incomingDir = mode(join(h.receiver.stateDir, INCOMING_DIR));
    };
    await runPrimarySwitch(h.deps);
    expect(seen.outgoingDb).toBe(0o600);
    expect(seen.incomingDir).toBe(0o700);
    for (const [k, v] of Object.entries(seen)) if (k.startsWith("staged:")) expect([k, v]).toEqual([k, 0o600]);
    reboot(h.receiver, "m-new");
    expect(mode(h.receiver.dbPath)).toBe(0o600);
    expect(mode(join(h.receiver.stateDir, "nodes"))).toBe(0o700);
    expect(mode(join(h.receiver.stateDir, "nodes", "m-new.token"))).toBe(0o600);
    expect(mode(join(h.receiver.stateDir, "license-token"))).toBe(0o600);
    expect(mode(join(h.receiver.secretsDir, "installation-id"))).toBe(0o600);
  });

  ownerModeTest("the restored DB is closed to owner-only even when the staged copy arrived wider", async () => {
    const h = harness();
    await runPrimarySwitch(h.deps);
    // A staged DB widened on its way (another umask, a copy by hand) must not stay readable by others.
    chmodSync(join(h.receiver.stateDir, INCOMING_DIR, DB_NAME), 0o644);
    reboot(h.receiver, "m-new");
    expect(mode(h.receiver.dbPath)).toBe(0o600);
  });

  test("the old primary refuses writes after the switch, before and after its restart", async () => {
    const h = harness();
    await runPrimarySwitch(h.deps);
    expect(h.old.role.isPrimary()).toBe(false);
    const refused = retiredRefusal("/api/tasks", "POST");
    expect(refused?.status).toBe(409);
    expect((await refused!.json() as { code: string }).code).toBe(MOVED_CODE);
    expect(retiredRefusal("/api/tasks", "GET")).toBeNull();
    expect(readRetired(h.old.appDataDir)?.phase).toBe("pending-set-aside");

    // The process ends; nothing in memory survives. The boot alone must put the fence back.
    setPrimaryFence(null);
    h.old.db.close();
    const old = reboot(h.old, "m-old");
    expect(old.role.isPrimary()).toBe(false);
    expect(retiredRefusal("/api/tasks", "POST")?.status).toBe(409);
    expect(existsSync(`${h.old.dbPath}.prima-2`)).toBe(true);
    expect(existsSync(join(h.old.stateDir, "nodes"))).toBe(false);
    expect(existsSync(join(h.old.stateDir, "license-token.prima-2"))).toBe(true);
    expect(existsSync(join(h.old.secretsDir, "installation-id.prima-2"))).toBe(true);
    expect(readRetired(h.old.appDataDir)).toMatchObject({ epoch: 2, toMachineId: "m-new", phase: "set-aside" });
    // Set aside, it may become a node of the new primary: pairing opens again, client writes do not.
    expect(retiredRefusal("/api/auth/pair/request", "POST")).toBeNull();
    expect(retiredRefusal("/api/topics/x/messages", "DELETE")?.status).toBe(409);
  });

  test("the commit taken but its answer lost: after both restart there is ONE primary", async () => {
    const h = harness();
    const commit = h.deps.commit;
    h.deps.commit = async (manifest) => {
      // The sealed marker is on disk before the commit leaves.
      expect(readRetired(h.old.appDataDir)?.phase).toBe("sent");
      await commit(manifest);
      return { kind: "unknown", error: "socket closed" };
    };
    const report = await runPrimarySwitch(h.deps);
    expect(report.outcome).toBe("uncertain");
    expect(h.restarts()).toBe(0);
    expect(existsSync(join(h.old.stateDir, OUTGOING_DIR))).toBe(false);

    setPrimaryFence(null);
    h.old.db.close();
    const old = reboot(h.old, "m-old");
    expect(old.role.isPrimary()).toBe(false);
    expect(retiredRefusal("/api/tasks", "POST")?.status).toBe(409);
    // The fence is per process: the second computer boots in "another process" after this check.
    const receiver = reboot(h.receiver, "m-new");
    expect(receiver.role.isPrimary()).toBe(true);
    expect(receiver.role.epoch()).toBe(2);
    // Uncertain keeps the data where it is: nobody knows yet which copy is the live one.
    expect(existsSync(h.old.dbPath)).toBe(true);
    expect(existsSync(`${h.old.dbPath}.prima-2`)).toBe(false);
  });

  test("a crash while the commit is in flight boots fenced and a secondary", async () => {
    let reached!: () => void;
    const commitLeft = new Promise<void>((r) => { reached = r; });
    // The commit never answers: the process dies with it in flight, nothing after `seal` ever runs.
    const h = harness({ commit: () => { reached(); return new Promise(() => {}); } });
    void runPrimarySwitch(h.deps);
    await commitLeft;
    expect(readRetired(h.old.appDataDir)?.phase).toBe("sent");
    expect(h.old.role.isPrimary()).toBe(true);
    setPrimaryFence(null);
    const old = reboot(h.old, "m-old");
    expect(old.role.isPrimary()).toBe(false);
    expect(old.role.epoch()).toBe(2);
    expect(retiredRefusal("/api/auth/devices/d1", "DELETE")?.status).toBe(409);
  });

  test("reclaim: only out of an uncertain switch, and it makes this server the primary above every epoch", async () => {
    const h = harness({ commit: async () => ({ kind: "unknown", error: "timeout" }) });
    await runPrimarySwitch(h.deps);
    let restarted = 0;
    const result = reclaimPrimary({ appDataDir: h.old.appDataDir, role: h.old.role, localMachineId: "m-old", restart: () => { restarted++; } });
    expect(result).toEqual({ ok: true, epoch: 3 });
    expect(restarted).toBe(1);
    expect(h.old.role.isPrimary()).toBe(true);
    expect(readRetired(h.old.appDataDir)).toBeNull();
    expect(retiredRefusal("/api/tasks", "POST")).toBeNull();

    const done = harness();
    await runPrimarySwitch(done.deps);
    const refused = reclaimPrimary({ appDataDir: done.old.appDataDir, role: done.old.role, localMachineId: "m-old", restart: () => {} });
    expect(refused).toMatchObject({ ok: false, code: "not_uncertain" });
    expect(done.old.role.isPrimary()).toBe(false);
  });

  test("after the snapshot nothing writes: revocations, share links, sockets", async () => {
    const asked: Array<[string, number | undefined]> = [];
    const h = harness();
    const upload = h.deps.upload;
    h.deps.upload = async (name, offset, bytes) => {
      if (name === DB_NAME && offset === 0) {
        for (const [path, method] of [["/api/auth/devices/d1", "DELETE"], ["/api/share-links/s1", "DELETE"], ["/api/nodes/runs/r1", "POST"], ["/ws", "GET"], ["/uploads/x", "PUT"]]) {
          asked.push([`${method} ${path}`, retiredRefusal(path!, method!)?.status]);
        }
      }
      await upload(name, offset, bytes);
    };
    await runPrimarySwitch(h.deps);
    expect(asked.length).toBe(5);
    for (const [what, status] of asked) expect([what, status]).toEqual([what, 409]);
  });

  test("after the snapshot the internal writers stop too: scheduled jobs and the dispatcher ask the role", async () => {
    const h = harness();
    // What the schedule engine and the dispatcher reconcile do at every beat: write only on the primary.
    const internalWriter = () => {
      if (isThisServerPrimary()) h.old.db.query("INSERT INTO messages (topic_id, body) VALUES ('topic-1', 'internal write during upload')").run();
    };
    const seen: boolean[] = [];
    const upload = h.deps.upload;
    h.deps.upload = async (name, offset, bytes) => {
      seen.push(isThisServerPrimary());
      internalWriter();
      await upload(name, offset, bytes);
    };
    const report = await runPrimarySwitch(h.deps);
    expect(report.outcome).toBe("switched");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((primary) => primary === false)).toBe(true);
    const written = h.old.db.query("SELECT COUNT(*) AS n FROM messages WHERE body = 'internal write during upload'").get() as { n: number };
    expect(written.n).toBe(0);
    setPrimaryFence(null);
    expect(isThisServerPrimary()).toBe(true);
  });

  test("the front door asks the access gate first: an unauthenticated caller learns nothing", async () => {
    setPrimaryFence({ epoch: 2, toMachineId: "m-new", toName: "server", at: "", phase: "uncertain" });
    const denied = new Response("unauthorized", { status: 401 });
    const answer = gatedRefusal(() => denied, "/api/tasks", "POST");
    expect(answer?.status).toBe(401);
    expect(await answer!.text()).not.toContain("m-new");
    expect(gatedRefusal(() => null, "/api/tasks", "POST")?.status).toBe(409);
    expect(gatedRefusal(() => null, "/api/tasks", "GET")).toBeNull();
  });

  test("the fence phases: strict until set aside, then the node and pairing routes open", () => {
    for (const phase of ["fencing", "sent", "uncertain", "pending-set-aside"] as const) {
      expect(isRefusedWhenRetired("/api/auth/devices/x", "DELETE", phase)).toBe(true);
      expect(isRefusedWhenRetired("/api/nodes/primary/commit", "POST", phase)).toBe(true);
      expect(isRefusedWhenRetired("/ws", "GET", phase)).toBe(true);
      expect(isRefusedWhenRetired("/api/tasks", "GET", phase)).toBe(false);
    }
    expect(isRefusedWhenRetired("/api/nodes/primary/commit", "POST", "set-aside")).toBe(false);
    expect(isRefusedWhenRetired("/api/auth/pair/request", "POST", "set-aside")).toBe(false);
    expect(isRefusedWhenRetired("/api/topics/x/messages", "DELETE", "set-aside")).toBe(true);
    expect(isRefusedWhenRetired("/ws", "GET", "set-aside")).toBe(true);
  });

  test("work still running when the drain is over is parked with a note", async () => {
    const h = harness({ stillWorking: () => [{ taskId: "t3", sessionKey: "topic:card-3" }], drainTimeoutMs: 0 });
    const report = await runPrimarySwitch(h.deps);
    expect(report.outcome).toBe("switched");
    expect(report.parked).toEqual(["t3"]);
    expect(h.parkedNotes).toEqual([`t3:${PARK_NOTE}`]);
  });

  test("a refused commit undoes everything and the old stays the primary, also after a restart", async () => {
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
    expect(existsSync(join(h.old.stateDir, OUTGOING_DIR))).toBe(false);
    expect(h.restarts()).toBe(0);
    h.old.db.close();
    expect(reboot(h.old, "m-old").role.isPrimary()).toBe(true);
    expect(retiredRefusal("/api/tasks", "POST")).toBeNull();
  });

  test("the receiver refuses a bundle for another computer, a stale epoch or a tampered file", async () => {
    const h = harness({ commit: async (manifest) => {
      for (const [local, code] of [[{ hostname: "other", epoch: 0 }, "wrong_machine"], [{ hostname: "new-host", epoch: 2 }, "stale_epoch"]] as const) {
        const v = await commitIncoming(h.receiver.stateDir, manifest, local);
        expect(v.ok ? "ok" : v.code).toBe(code);
      }
      const tampered = { ...manifest, files: manifest.files.map((f) => f.name === "state/license-token" ? { ...f, sha256: "0".repeat(64) } : f) };
      const v = await commitIncoming(h.receiver.stateDir, tampered, { hostname: "new-host", epoch: 0 });
      expect(v.ok ? "ok" : v.code).toBe("hash_mismatch");
      return { kind: "refused", code: "test", error: "checked" };
    } });
    const report = await runPrimarySwitch(h.deps);
    expect(report.outcome).toBe("refused");
    // Nothing committed: the next boot restores nothing and drops what was staged.
    expect(applyPendingPrimaryChange({ ...h.receiver, log: () => {} })).toBeNull();
    expect(existsSync(join(h.receiver.stateDir, INCOMING_DIR))).toBe(false);
  });

  test("the closed list: only the files a primary owns, never code, hooks or provider keys", () => {
    for (const bad of [
      "../x", "state/../../etc", "/abs", "state/", "other/file", "transcripts/a//b", "state/a\\b",
      "state/.git/hooks/pre-commit", "state/server/server.ts", "state/package.json", "state/.topics-secrets/session-signing.key",
      "state/nodes/../license-token", "state/nodes/x.json", "secrets/relay-secret", "state/installation-id",
      "transcripts/.hidden/x.jsonl", "transcripts/p/../x.jsonl", "transcripts/x.jsonl",
    ]) {
      expect([bad, isSafeBundleName(bad)]).toEqual([bad, false]);
    }
    for (const good of [
      DB_NAME, "state/nodes/m-1.token", "state/nodes/m-1.model-token.sha256", "state/nodes/delegated/m-1/cap-2.token",
      "state/license-token", "secrets/installation-id", `transcripts/-src-project/${SESSION}.jsonl`,
      `transcripts/-src-project/${SESSION}/subagents/agent-1.jsonl`,
    ]) {
      expect([good, isSafeBundleName(good)]).toEqual([good, true]);
    }
    const c = computer("chunks");
    writeIncomingChunk(c.stateDir, "state/license-token", 0, new Uint8Array([1, 2]));
    expect(() => writeIncomingChunk(c.stateDir, "state/license-token", 0 + 1, new Uint8Array([3]))).toThrow();
    expect(writeIncomingChunk(c.stateDir, "state/license-token", 2, new Uint8Array([3]))).toBe(3);
  });

  test("a manifest naming a file off the list restores nothing", () => {
    const c = computer("hostile");
    mkdirSync(join(c.stateDir, INCOMING_DIR, "state", ".git", "hooks"), { recursive: true });
    writeFileSync(join(c.stateDir, INCOMING_DIR, "state", ".git", "hooks", "pre-commit"), "evil");
    writeFileSync(join(c.stateDir, INCOMING_DIR, "manifest.json"), JSON.stringify({
      version: 1, epoch: 2, toMachineId: "m", toHostname: "h", fromMachineId: "x", createdAt: "", counts: {},
      files: [{ name: "state/.git/hooks/pre-commit", size: 4, sha256: "" }],
    }));
    expect(() => applyPendingPrimaryChange({ ...c, log: () => {} })).toThrow();
    expect(existsSync(join(c.stateDir, ".git"))).toBe(false);
  });

  test("the bundle leaves only over an encrypted channel", () => {
    expect(encryptedChannelError("https://node.example:3333")).toBeNull();
    expect(encryptedChannelError("http://127.0.0.1:43001")).toBeNull();
    expect(encryptedChannelError("http://[::1]:43001")).toBeNull();
    expect(encryptedChannelError("http://192.168.1.20:3333")).not.toBeNull();
    expect(encryptedChannelError("http://node.tailnet.example:3333")).not.toBeNull();
    expect(encryptedChannelError("not a url")).not.toBeNull();
  });
});
