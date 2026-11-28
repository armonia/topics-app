/**
 * @covers MACHINE-07
 *
 * The files of a primary switch that are not the DB: which copy of a CLI
 * transcript survives when both computers have one, and the attachments, views
 * and uploads that chats point at. Two computers in one process, the real
 * `runPrimarySwitch` on the sender and the receiver's own staging and boot
 * code; only the transport is a function call.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrimaryRole } from "./primary-role";
import {
  applyPendingPrimaryChange, collectAttachmentFiles, commitIncoming, DB_NAME, isSafeBundleName, writeIncomingChunk,
} from "./primary-switch";
import { findCliTranscript } from "./subagent-migration";
import { runPrimarySwitch } from "../services/primary-switch-run";

const SESSION = "0b7c2a52-6d1e-4a3f-9b58-1f2e3d4c5b6a";
const roots: string[] = [];
const open: Database[] = [];

afterEach(() => {
  for (const db of open.splice(0)) db.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function computer(label: string) {
  const root = mkdtempSync(join(tmpdir(), `primary-files-${label}-`));
  roots.push(root);
  const stateDir = join(root, "state");
  const dataDir = join(stateDir, "data");
  const appDataDir = join(root, "app-data");
  const projectsDir = join(root, "claude-projects");
  for (const d of [dataDir, appDataDir, projectsDir]) mkdirSync(d, { recursive: true });
  return { root, stateDir, dataDir, appDataDir, projectsDir, dbPath: join(dataDir, DB_NAME), secretsDir: join(stateDir, ".topics-secrets"),
    transcript: join(projectsDir, "-src-project", `${SESSION}.jsonl`) };
}
type Computer = ReturnType<typeof computer>;

const write = (path: string, content: string | Uint8Array, mtimeMs?: number) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  if (mtimeMs !== undefined) utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
};
const turns = (n: number) => Array.from({ length: n }, (_, i) => JSON.stringify({ turn: i + 1 }) + "\n").join("");
const mode = (path: string) => statSync(path).mode & 0o777;
const ownerModeTest = process.platform === "win32" ? test.skip : test;

/** Moves the primary from `from` to `to` and runs the receiver's boot. Returns the receiver's epoch. */
async function move(from: Computer, to: Computer): Promise<number> {
  const db = new Database(from.dbPath);
  open.push(db);
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE topics (id TEXT PRIMARY KEY, session_key TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, topic_id TEXT, body TEXT);
    CREATE TABLE claude_code_sessions (session_key TEXT PRIMARY KEY, claude_session_id TEXT);`);
  db.exec(readFileSync(join(import.meta.dir, "../db/migrations/20261118110000-primary-state.sql"), "utf-8"));
  db.query("INSERT INTO topics (id, session_key) VALUES ('topic-1', 'topic:topic-1')").run();
  db.query("INSERT INTO claude_code_sessions VALUES ('topic:topic-1', ?)").run(SESSION);
  const role = createPrimaryRole({ db, stateFile: join(from.appDataDir, "primary-state.json"), localMachineId: () => "m-old", log: () => {} });
  role.adopt({ primaryMachineId: "m-old", epoch: 1 });
  const report = await runPrimarySwitch({
    db, stateDir: from.stateDir, secretsDir: from.secretsDir, appDataDir: from.appDataDir, projectsDir: from.projectsDir,
    dataDir: from.dataDir, role, localMachineId: "m-old", target: { id: "m-new", hostname: "new-host", name: "server" },
    drain: () => {}, undrain: () => {}, stillWorking: () => [], park: async () => {}, setFence: () => {},
    upload: async (name, offset, bytes) => { writeIncomingChunk(to.stateDir, name, offset, bytes); },
    commit: async (manifest) => {
      const v = await commitIncoming(to.stateDir, manifest, { hostname: "new-host", epoch: 0 });
      return v.ok ? { kind: "accepted", counts: v.counts } : { kind: "refused", code: v.code, error: v.error };
    },
    restartSelf: () => {}, sleep: async () => {}, pollMs: 0, chunkBytes: 4096, log: () => {},
  });
  expect(report.outcome).toBe("switched");
  expect(applyPendingPrimaryChange({ ...to, log: () => {} })).toBe("restored");
  return report.epoch!;
}

describe("primary switch: the transcript that is already on the receiver", () => {
  const T0 = Date.UTC(2026, 0, 1);

  test("the longer copy wins when one is the start of the other: a session never goes back in time", async () => {
    const from = computer("old"); const to = computer("new");
    write(from.transcript, turns(1), T0);
    write(to.transcript, turns(3), T0 - 86_400_000);
    await move(from, to);
    expect(readFileSync(findCliTranscript(SESSION, to.projectsDir)!, "utf-8")).toBe(turns(3));
  });

  test("the shipped copy replaces a shorter one, which is kept aside", async () => {
    const from = computer("old"); const to = computer("new");
    write(from.transcript, turns(3), T0);
    write(to.transcript, turns(1), T0 + 86_400_000);
    const epoch = await move(from, to);
    expect(readFileSync(to.transcript, "utf-8")).toBe(turns(3));
    expect(readFileSync(`${to.transcript}.prima-${epoch}`, "utf-8")).toBe(turns(1));
  });

  test("two copies that diverged: the more recent one wins and the other stays aside", async () => {
    const shippedIsNewer = { from: computer("old"), to: computer("new") };
    write(shippedIsNewer.from.transcript, turns(2).replace("2", "9"), T0 + 1_000);
    write(shippedIsNewer.to.transcript, turns(2), T0);
    const epoch = await move(shippedIsNewer.from, shippedIsNewer.to);
    expect(readFileSync(shippedIsNewer.to.transcript, "utf-8")).toBe(turns(2).replace("2", "9"));
    expect(readFileSync(`${shippedIsNewer.to.transcript}.prima-${epoch}`, "utf-8")).toBe(turns(2));

    const existingIsNewer = { from: computer("old"), to: computer("new") };
    write(existingIsNewer.from.transcript, turns(2).replace("2", "9"), T0);
    write(existingIsNewer.to.transcript, turns(2), T0 + 1_000);
    const epoch2 = await move(existingIsNewer.from, existingIsNewer.to);
    expect(readFileSync(existingIsNewer.to.transcript, "utf-8")).toBe(turns(2));
    expect(readFileSync(`${existingIsNewer.to.transcript}.prima-${epoch2}`, "utf-8")).toBe(turns(2).replace("2", "9"));
  });
});

describe("primary switch: attachments, uploads, views and kept transcripts", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255, 254, 13, 10]);

  function senderWithFiles() {
    const from = computer("old");
    write(from.transcript, turns(1));
    write(join(from.appDataDir, "media", "task-previews", "Schermata 2026 (1).png"), png);
    write(join(from.stateDir, "uploads", "scan.pdf"), png);
    write(join(from.stateDir, "context-files", "topic-1", "Appunti riunione.txt"), "context a person attached");
    write(join(from.dataDir, "views", "view-1.json"), '{"spec":{}}');
    // The keeper's copy of a session whose CLI file is gone: the only copy there is.
    write(join(from.dataDir, "claude-transcripts", "feedface-0000-4000-8000-000000000000.jsonl"), turns(2));
    return from;
  }

  ownerModeTest("an attachment, an upload, a view and a kept transcript arrive with the same bytes, owner only", async () => {
    const from = senderWithFiles(); const to = computer("new");
    await move(from, to);
    const arrived = [
      [join(to.appDataDir, "media", "task-previews", "Schermata 2026 (1).png"), png],
      [join(to.stateDir, "uploads", "scan.pdf"), png],
      [join(to.stateDir, "context-files", "topic-1", "Appunti riunione.txt"), Buffer.from("context a person attached")],
      [join(to.dataDir, "views", "view-1.json"), Buffer.from('{"spec":{}}')],
      [join(to.dataDir, "claude-transcripts", "feedface-0000-4000-8000-000000000000.jsonl"), Buffer.from(turns(2))],
    ] as const;
    for (const [path, bytes] of arrived) {
      expect(Buffer.from(readFileSync(path)).equals(Buffer.from(bytes))).toBe(true);
      expect(mode(path)).toBe(0o600);
    }
    // The folder made for a topic's context files is owner-only too.
    expect(mode(join(to.stateDir, "context-files", "topic-1"))).toBe(0o700);
  });

  test("a file already on the receiver is never lost: other bytes go aside, the same bytes stay put", async () => {
    const from = senderWithFiles(); const to = computer("new");
    const clash = join(to.appDataDir, "media", "task-previews", "Schermata 2026 (1).png");
    write(clash, "what the receiver had");
    const same = join(to.stateDir, "uploads", "scan.pdf");
    write(same, png);
    const contextClash = join(to.stateDir, "context-files", "topic-1", "Appunti riunione.txt");
    write(contextClash, "context the receiver had");
    const epoch = await move(from, to);
    expect(readFileSync(`${clash}.prima-${epoch}`, "utf-8")).toBe("what the receiver had");
    expect(readFileSync(`${contextClash}.prima-${epoch}`, "utf-8")).toBe("context the receiver had");
    expect(readFileSync(contextClash, "utf-8")).toBe("context a person attached");
    expect(Buffer.from(readFileSync(clash)).equals(Buffer.from(png))).toBe(true);
    expect(existsSync(`${same}.prima-${epoch}`)).toBe(false);
  });

  test("the keeper's copy of a transcript that already travels is not shipped twice", () => {
    const from = senderWithFiles();
    write(join(from.dataDir, "claude-transcripts", `${SESSION}.jsonl`), turns(1));
    const shipped = [{ name: `transcripts/-src-project/${SESSION}.jsonl`, source: from.transcript }];
    const names = collectAttachmentFiles(from, shipped).map((f) => f.name);
    expect(names).toContain("claude-transcripts/feedface-0000-4000-8000-000000000000.jsonl");
    expect(names).not.toContain(`claude-transcripts/${SESSION}.jsonl`);
  });

  test("the closed list: nothing outside the four folders, no `..`, no hidden file", () => {
    for (const bad of [
      "media/../state/license-token", "media/a/../../b", "media/.hidden", "media/a/.git/config", "media/", "media//x", "media/a\\b",
      "uploads/../../etc/passwd", "uploads/", "context-files/", "context-files/topic-1", "context-files/../x/y", "context-files/topic-1/.hidden",
      "context-files/a b/x.txt", "views/a/b.json", "views/x.html", "views/../x.json", "claude-transcripts/x.txt",
      "claude-transcripts/a/b.jsonl", "workspace/x", "data/topics.db", "Media/x",
    ]) {
      expect([bad, isSafeBundleName(bad)]).toEqual([bad, false]);
    }
    for (const good of ["media/x.png", "media/task-previews/a b (1).png", "uploads/scan.pdf", "context-files/topic-1/notes.txt", "context-files/topic:2/a b/x.txt", "views/view-1.json", `claude-transcripts/${SESSION}.jsonl`]) {
      expect([good, isSafeBundleName(good)]).toEqual([good, true]);
    }
  });

  test("a manifest that names a path outside the list restores nothing", () => {
    const c = computer("hostile");
    write(join(c.stateDir, "primary-incoming", "media", "x.png"), "x");
    writeFileSync(join(c.stateDir, "primary-incoming", "manifest.json"), JSON.stringify({
      version: 1, epoch: 2, toMachineId: "m", toHostname: "h", fromMachineId: "x", createdAt: "", counts: {},
      files: [{ name: "media/../../state/license-token", size: 1, sha256: "" }],
    }));
    expect(() => applyPendingPrimaryChange({ ...c, log: () => {} })).toThrow();
    expect(existsSync(join(c.stateDir, "license-token"))).toBe(false);
  });

  ownerModeTest("a symbolic link never carries a file out: not shipped from the sender, not written through on the receiver", async () => {
    const from = senderWithFiles(); const to = computer("new");
    const outside = join(from.root, "outside");
    write(join(outside, "secret.txt"), "not an attachment");
    symlinkSync(outside, join(from.appDataDir, "media", "linked-dir"));
    symlinkSync(join(outside, "secret.txt"), join(from.appDataDir, "media", "linked-file.txt"));
    symlinkSync(outside, join(from.stateDir, "context-files", "linked-topic"));
    expect(collectAttachmentFiles(from).map((f) => f.name).filter((n) => n.includes("linked"))).toEqual([]);

    // On the receiver a folder of the media tree is a link out: the file meant for it is dropped, the target is untouched.
    const receiverOutside = join(to.root, "elsewhere");
    mkdirSync(receiverOutside, { recursive: true });
    mkdirSync(join(to.appDataDir, "media"), { recursive: true });
    symlinkSync(receiverOutside, join(to.appDataDir, "media", "task-previews"));
    mkdirSync(join(to.stateDir, "context-files"), { recursive: true });
    symlinkSync(receiverOutside, join(to.stateDir, "context-files", "topic-1"));
    await move(from, to);
    expect(existsSync(join(receiverOutside, "Schermata 2026 (1).png"))).toBe(false);
    expect(existsSync(join(receiverOutside, "Appunti riunione.txt"))).toBe(false);
    expect(Buffer.from(readFileSync(join(to.stateDir, "uploads", "scan.pdf"))).equals(Buffer.from(png))).toBe(true);
  });
});
