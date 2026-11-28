/**
 * @covers MACHINE-07
 *
 * A PRIMARY SWITCH LEAVES NOTHING GIT WOULD SEE IN THE CHECKOUT.
 *
 * When the server runs from a checkout its state folder IS the checkout root,
 * and the repository is public. The switch writes the instance files there on
 * the receiver, and on both sides renames what it replaces or hands over to
 * `<name>.prima-<epoch>`: topic memory, node tokens, the VAPID private key. One
 * of those left untracked is one `git add -A` away from being published. Here
 * both sides run against a git repository carrying the real `.gitignore`, and
 * `git status --porcelain` must stay empty.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTANCE_ENTRIES, instanceEntryPath, type InstanceEntry } from "../../server/lib/instance-files";
import {
  applyPendingPrimaryChange, collectAttachmentFiles, collectStateFiles, commitIncoming, DB_NAME, sha256File,
  snapshotDatabase, writeIncomingChunk, writeRetired, type SwitchManifest,
} from "../../server/lib/primary-switch";

const ROOT = join(import.meta.dir, "..", "..");

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

describe("the files a primary switch writes in a checkout are ignored by git", () => {
  const roots: string[] = [];
  const open: Database[] = [];
  afterEach(() => {
    for (const db of open.splice(0)) db.close();
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  /** A computer whose state folder is a fresh checkout with the repository's `.gitignore`, its app data outside. */
  function checkout(label: string) {
    const root = mkdtempSync(join(tmpdir(), `switch-gitignore-${label}-`));
    roots.push(root);
    const stateDir = join(root, "repo");
    mkdirSync(stateDir, { recursive: true });
    git(stateDir, "init", "-q");
    copyFileSync(join(ROOT, ".gitignore"), join(stateDir, ".gitignore"));
    git(stateDir, "add", ".gitignore");
    git(stateDir, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "init");
    const dirs = { stateDir, secretsDir: join(stateDir, ".topics-secrets"), appDataDir: join(root, "app-data"), dataDir: join(stateDir, "data") };
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
    return { ...dirs, dbPath: join(dirs.dataDir, DB_NAME), projectsDir: join(root, "claude-projects") };
  }

  const sampleOf = (entry: InstanceEntry, dirs: ReturnType<typeof checkout>): string => {
    const base = instanceEntryPath(entry, dirs);
    if (entry.type === "file") return base;
    const sample = { nodes: "a-node.token", memory: "topic-1.md", media: "photo.png", uploads: "doc.pdf", "context-files": "topic-1/notes.txt", views: "view-1.json", "claude-transcripts": "11111111.jsonl" }[entry.prefix === "state" ? entry.path : entry.prefix];
    return join(base, sample!);
  };

  function fill(dirs: ReturnType<typeof checkout>, label: string): void {
    for (const entry of INSTANCE_ENTRIES) {
      const file = sampleOf(entry, dirs);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, `${label} ${entry.prefix}/${entry.path}`);
    }
    const db = new Database(dirs.dbPath);
    db.exec(`CREATE TABLE tasks (id TEXT); CREATE TABLE topics (id TEXT); CREATE TABLE messages (id INTEGER);`);
    open.push(db);
  }

  test("the receiver's restore and the sender's set-aside leave git status empty", async () => {
    const from = checkout("from");
    const to = checkout("to");
    fill(from, "from");
    // The receiver already has its own copy of every file: the restore renames each one aside.
    fill(to, "to");
    open.splice(0).forEach((db) => db.close());

    const db = new Database(from.dbPath);
    open.push(db);
    const copy = join(from.stateDir, "primary-outgoing", DB_NAME);
    const counts = snapshotDatabase(db, copy);
    const sources = [{ name: DB_NAME, source: copy }, ...collectStateFiles(from), ...collectAttachmentFiles(from)];
    const files: SwitchManifest["files"] = [];
    for (const s of sources) {
      const bytes = new Uint8Array(readFileSync(s.source));
      writeIncomingChunk(to.stateDir, s.name, 0, bytes);
      files.push({ name: s.name, size: bytes.byteLength, sha256: await sha256File(s.source) });
    }
    const manifest: SwitchManifest = { version: 1, epoch: 2, toMachineId: "m-to", toHostname: "to-host", fromMachineId: "m-from", createdAt: "2026-01-01T00:00:00.000Z", counts, files };
    expect((await commitIncoming(to.stateDir, manifest, { hostname: "to-host", epoch: 1, freeBytes: () => Number.MAX_SAFE_INTEGER })).ok).toBe(true);
    expect(git(to.stateDir, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(applyPendingPrimaryChange({ ...to, log: () => {} })).toBe("restored");
    // The shipped files are in place, the receiver's own ones aside: some of each must exist for the check to mean anything.
    expect(readFileSync(sampleOf(INSTANCE_ENTRIES.find((e) => e.path === "memory")!, to), "utf-8")).toStartWith("from");
    expect(git(to.stateDir, "status", "--porcelain", "--untracked-files=all")).toBe("");

    db.close();
    open.splice(0);
    rmSync(join(from.stateDir, "primary-outgoing"), { recursive: true, force: true });
    writeRetired(from.appDataDir, { epoch: 2, toMachineId: "m-to", toName: "to", at: "2026-01-01T00:00:00.000Z", phase: "pending-set-aside" });
    expect(applyPendingPrimaryChange({ ...from, log: () => {} })).toBe("set-aside");
    expect(git(from.stateDir, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });
});
