/**
 * @covers MACHINE-07
 *
 * The receiver's restore after the commit has left. Two claims:
 *  - a copy that fails half way (no permission, no space) leaves the receiver
 *    on its OWN DB with no `primary-state.json`, so it never runs as a primary
 *    without the files the other computer shipped; the manifest stays staged
 *    and the next boot finishes the job;
 *  - the commit is refused up front when the disk cannot hold the restore, and
 *    a refusal changes nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPendingPrimaryChange, collectAttachmentFiles, commitIncoming, countRows, DB_NAME, INCOMING_DIR, MANIFEST_FILE,
  PRIMARY_STATE_FILE, restoreSpaceNeeded, sha256File, snapshotDatabase, SPACE_MARGIN_BYTES, type SwitchManifest, writeIncomingChunk,
} from "./primary-switch";

const migration = readFileSync(join(import.meta.dir, "../db/migrations/20261118110000-primary-state.sql"), "utf-8");
const roots: string[] = [];
const open: Database[] = [];

afterEach(() => {
  for (const db of open.splice(0)) { try { db.close(); } catch { /* closed by the test */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function computer(label: string) {
  const root = mkdtempSync(join(tmpdir(), `primary-restore-${label}-`));
  roots.push(root);
  const stateDir = join(root, "state");
  const dataDir = join(stateDir, "data");
  const appDataDir = join(root, "app-data");
  for (const d of [dataDir, appDataDir]) mkdirSync(d, { recursive: true });
  return { root, stateDir, dataDir, appDataDir, dbPath: join(dataDir, DB_NAME), secretsDir: join(stateDir, ".topics-secrets"), projectsDir: join(root, "claude-projects") };
}
type Computer = ReturnType<typeof computer>;

function dbWith(c: Computer, messages: number): Database {
  const db = new Database(c.dbPath);
  open.push(db);
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE topics (id TEXT PRIMARY KEY, session_key TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, topic_id TEXT, body TEXT);
    CREATE TABLE claude_code_sessions (session_key TEXT PRIMARY KEY, claude_session_id TEXT);`);
  db.exec(migration);
  for (let i = 0; i < messages; i++) db.query("INSERT INTO messages (topic_id, body) VALUES ('t', ?)").run(`m${i}`);
  return db;
}

/** Stages the sender's DB and its media files on `to`, as the uploads of a switch do. Returns the manifest to commit. */
async function stage(from: Computer, fromDb: Database, to: Computer, epoch: number): Promise<SwitchManifest> {
  const copy = join(from.stateDir, "outgoing", DB_NAME);
  const counts = snapshotDatabase(fromDb, copy);
  const sources = [{ name: DB_NAME, source: copy }, ...collectAttachmentFiles(from)];
  const files: SwitchManifest["files"] = [];
  for (const s of sources) {
    const bytes = new Uint8Array(readFileSync(s.source));
    writeIncomingChunk(to.stateDir, s.name, 0, bytes);
    files.push({ name: s.name, size: bytes.byteLength, sha256: await sha256File(s.source) });
  }
  return { version: 1, epoch, toMachineId: "m-to", toHostname: "to-host", fromMachineId: "m-from", createdAt: "2026-01-01T00:00:00.000Z", counts, files };
}

const apply = (c: Computer) => applyPendingPrimaryChange({
  stateDir: c.stateDir, secretsDir: c.secretsDir, dbPath: c.dbPath, appDataDir: c.appDataDir, projectsDir: c.projectsDir, log: () => {},
});

const plenty = () => Number.MAX_SAFE_INTEGER;

describe("primary switch: a restore whose copy fails", () => {
  test("the receiver keeps its own DB and is not the primary; the next boot finishes the restore", async () => {
    const sender = computer("sender");
    const receiver = computer("receiver");
    const senderDb = dbWith(sender, 30);
    mkdirSync(join(sender.appDataDir, "media"), { recursive: true });
    writeFileSync(join(sender.appDataDir, "media", "photo.png"), "pixels");
    const receiverDb = dbWith(receiver, 3);
    receiverDb.close();

    const manifest = await stage(sender, senderDb, receiver, 1);
    expect((await commitIncoming(receiver.stateDir, manifest, { hostname: "to-host", epoch: 0, freeBytes: plenty })).ok).toBe(true);

    // A regular file where the media folder should be: the copy fails whoever runs it, root included.
    writeFileSync(join(receiver.appDataDir, "media"), "in the way");
    expect(() => apply(receiver)).toThrow();

    // Nothing of the new primary took effect: its DB is still the receiver's own, and no role file says "primary".
    expect(existsSync(join(receiver.appDataDir, PRIMARY_STATE_FILE))).toBe(false);
    expect(existsSync(`${receiver.dbPath}.prima-1`)).toBe(false);
    const stillOwn = new Database(receiver.dbPath, { readonly: true });
    open.push(stillOwn);
    expect(countRows(stillOwn).messages).toBe(3);
    // And the restore is still pending: the manifest and the staged files wait for the next boot.
    expect(existsSync(join(receiver.stateDir, INCOMING_DIR, MANIFEST_FILE))).toBe(true);
    stillOwn.close();

    // The obstacle goes away: the next boot completes the restore.
    rmSync(join(receiver.appDataDir, "media"));
    expect(apply(receiver)).toBe("restored");
    const restored = new Database(receiver.dbPath, { readonly: true });
    open.push(restored);
    expect(countRows(restored).messages).toBe(30);
    expect(readFileSync(join(receiver.appDataDir, "media", "photo.png"), "utf-8")).toBe("pixels");
    expect(JSON.parse(readFileSync(join(receiver.appDataDir, PRIMARY_STATE_FILE), "utf-8")).epoch).toBe(1);
    expect(existsSync(join(receiver.stateDir, INCOMING_DIR))).toBe(false);
  });
});

describe("primary switch: the room the restore needs", () => {
  test("the commit is refused when the disk cannot hold the copies plus the margin, and nothing changes", async () => {
    const sender = computer("sender");
    const receiver = computer("receiver");
    const senderDb = dbWith(sender, 5);
    mkdirSync(join(sender.appDataDir, "media"), { recursive: true });
    writeFileSync(join(sender.appDataDir, "media", "photo.png"), "x".repeat(1000));
    const receiverDb = dbWith(receiver, 2);
    receiverDb.close();
    const manifest = await stage(sender, senderDb, receiver, 1);
    const needed = restoreSpaceNeeded(manifest.files);
    // The DB is renamed into place; only the 1000 bytes of the photo are copied, plus the margin.
    expect(needed).toBe(1000 + SPACE_MARGIN_BYTES);

    const refused = await commitIncoming(receiver.stateDir, manifest, { hostname: "to-host", epoch: 0, freeBytes: () => needed - 1 });
    expect(refused).toMatchObject({ ok: false, code: "no_space" });
    expect(existsSync(join(receiver.stateDir, INCOMING_DIR, MANIFEST_FILE))).toBe(false);
    expect(readdirSync(receiver.appDataDir)).toEqual([]);
    const own = new Database(receiver.dbPath, { readonly: true });
    open.push(own);
    expect(countRows(own).messages).toBe(2);
    own.close();

    // Exactly what it needs is enough.
    expect((await commitIncoming(receiver.stateDir, manifest, { hostname: "to-host", epoch: 0, freeBytes: () => needed })).ok).toBe(true);
  });

  test("the real disk is asked by default: a bundle bigger than any disk is refused for room, before anything is hashed", async () => {
    const receiver = computer("receiver");
    const manifest: SwitchManifest = {
      version: 1, epoch: 1, toMachineId: "m-to", toHostname: "to-host", fromMachineId: "m-from", createdAt: "2026-01-01T00:00:00.000Z",
      counts: { tasks: 0, messages: 0, topics: 0 },
      files: [{ name: DB_NAME, size: 1, sha256: "0" }, { name: "media/huge.bin", size: 2 ** 60, sha256: "0" }],
    };
    expect(await commitIncoming(receiver.stateDir, manifest, { hostname: "to-host", epoch: 0 })).toMatchObject({ ok: false, code: "no_space" });
  });
});
