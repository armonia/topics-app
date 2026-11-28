/**
 * @covers MACHINE-07
 *
 * THE LIST OF INSTANCE FILES IS THE LOCK ON WHAT A PRIMARY SWITCH CARRIES.
 *
 * A primary that moves to another computer takes its DB, and the files the
 * server keeps next to it. Four of those were read by the server and carried by
 * nobody (topic memory, waiting items, cloud runs, the VAPID keys): the new
 * primary booted without them and every push it sent was refused. The list of
 * `server/lib/instance-files.ts` is now the one place that names them; this test
 * is what fails when the server reads a state file the list does not know.
 *
 * Three claims:
 *  1. every state file name the server joins onto the state, app data, data or
 *     secrets folder is on the list or on the exclusions below, each with its
 *     reason, and an exclusion nobody reads any more is dropped;
 *  2. every entry the server reads through `instanceEntryPath` is in
 *     `INSTANCE_ENTRIES`, and the four readers above do read through it;
 *  3. every entry is shipped by the sender, accepted by the receiver's closed
 *     list and restored owner-only.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import * as instanceFiles from "../../server/lib/instance-files";
import {
  CLAUDE_CLOUD_RUNS, INSTANCE_ENTRIES, instanceEntryPath, TOPIC_MEMORY, VAPID_KEYS, WAITING_ITEMS, type InstanceEntry,
} from "../../server/lib/instance-files";
import {
  applyPendingPrimaryChange, collectAttachmentFiles, collectStateFiles, commitIncoming, DB_NAME, isSafeBundleName, sha256File,
  snapshotDatabase, writeIncomingChunk, type SwitchManifest,
} from "../../server/lib/primary-switch";

const ROOT = join(import.meta.dir, "..", "..");

/**
 * Names the server joins onto one of the instance folders and the switch does
 * NOT carry on purpose. Each says why. A name that is neither here nor on the
 * list fails the test: decide which it is.
 */
const NOT_CARRIED: Record<string, string> = {
  "data": "the folder of the DB: the DB travels as `topics.db`, the rest (usage meters) belongs to the machine",
  ".topics-secrets": "the secrets folder: only `installation-id` travels (it is on the list), provider keys reach a primary through its own store",
  "secrets.age": "the age-encrypted secret store file of a non-macOS machine: provider keys are never copied between machines, by design",
  "mcp-oauth.json": "OAuth grants issued to one machine's sign-in: the new primary signs in again, like for provider keys",
  "primary-state.json": "the role file the receiver writes itself at the end of the restore",
  "workspace": "project folders and working trees: code lives in git and every machine has its clone",
  "agents": "the agents' homes and the sessions written before SQLite; the CLI transcripts that matter travel under `transcripts/`",
  "messages": "message threads written before SQLite, read only as a fallback; the messages are in the DB",
  "topics.json": "exposed on the app context, no module reads it any more: topics live in the DB",
  "unread.json": "exposed on the app context, no module reads it any more: unread state lives in the DB",
  "topics-dev.json": "a flag file of the dev checkout (existence = on), never part of an installation",
  "agent-tools.json": "paths of MCP files and skill folders of THIS machine: meaningless on another",
  "browser-deps": "a download cache of the browser runtime, rebuilt by the machine that needs it",
  "chromium-sidecar": "the browser profile of this machine",
  "cache": "a rebuildable cache (reasoning translation)",
  "ssh-control": "SSH control sockets of this machine, alive only here",
  "orchestrator-cwd": "a scratch working folder for the orchestrator turns",
  "revisione-pr": "working data of the PR review runs on this machine",
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { sourceFiles(full, out); continue; }
    if (!name.endsWith(".ts") || name.includes(".test.") || name.endsWith(".d.ts")) continue;
    out.push(full);
  }
  return out;
}

/** A folder of the instance, as the server writes it in code: a variable or a call of the resolvers of `data-dir.ts`. */
const FOLDER = String.raw`(?:ctx\.)?(?:STATE_DIR|APP_DATA_DIR|SECRETS_DIR|DATA_DIR|stateDir|appDataDir|secretsDir|dataDir)|resolve(?:State|AppData|Data|Secrets)Dir\([^()]*\)`;
const JOINED_NAME = new RegExp(String.raw`\b(?:join|resolve)\(\s*(?:${FOLDER})\s*,\s*(["'\x60])([^"'\x60/\\]+)`, "g");
const READ_THROUGH_LIST = /\b(?:instanceEntryPath|instanceBaseDir)\(\s*([A-Z][A-Z_]+)\b/g;

const server = sourceFiles(join(ROOT, "server")).map((file) => ({ file: relative(ROOT, file), text: readFileSync(file, "utf-8") }));

/** First segment, under the instance folder, of every entry. */
const listedNames = new Set(INSTANCE_ENTRIES.map((e) => join(e.base, e.path).split("/")[0]!));

describe("the server reads no instance file the primary switch does not carry", () => {
  test("every state file name the server joins onto an instance folder is listed or excluded with a reason", () => {
    const read = new Map<string, string[]>();
    for (const { file, text } of server) {
      for (const m of text.matchAll(JOINED_NAME)) read.set(m[2]!, [...(read.get(m[2]!) ?? []), file]);
    }
    const unknown = [...read].filter(([name]) => !listedNames.has(name) && !(name in NOT_CARRIED)).map(([name, files]) => `${name} (${[...new Set(files)].join(", ")})`);
    expect(unknown).toEqual([]);
    // An exclusion nobody reads any more is stale: it would hide the next real one.
    expect(Object.keys(NOT_CARRIED).filter((name) => !read.has(name))).toEqual([]);
    // And a name cannot be both: the list wins, so an exclusion that is listed is a lie.
    expect(Object.keys(NOT_CARRIED).filter((name) => listedNames.has(name))).toEqual([]);
  });

  test("every entry the server reads through the list is in the list, and the four files that were missed do", () => {
    const used = new Set<string>();
    for (const { text } of server) for (const m of text.matchAll(READ_THROUGH_LIST)) used.add(m[1]!);
    const exported = instanceFiles as unknown as Record<string, unknown>;
    const missing = [...used].filter((name) => !INSTANCE_ENTRIES.includes(exported[name] as InstanceEntry));
    expect(missing).toEqual([]);
    for (const entry of [TOPIC_MEMORY, WAITING_ITEMS, CLAUDE_CLOUD_RUNS, VAPID_KEYS]) {
      const name = Object.entries(exported).find(([, v]) => v === entry)![0];
      expect([...used]).toContain(name);
    }
  });
});

describe("every entry of the list travels", () => {
  const roots: string[] = [];
  const open: Database[] = [];
  afterEach(() => {
    for (const db of open.splice(0)) db.close();
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  function computer(label: string) {
    const root = mkdtempSync(join(tmpdir(), `instance-files-${label}-`));
    roots.push(root);
    const stateDir = join(root, "state");
    const dirs = { stateDir, secretsDir: join(stateDir, ".topics-secrets"), appDataDir: join(root, "app-data"), dataDir: join(stateDir, "data") };
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
    return { root, ...dirs, dbPath: join(dirs.dataDir, DB_NAME), projectsDir: join(root, "claude-projects") };
  }

  /** The file (or one file of the folder) an entry stands for. */
  const sampleOf = (entry: InstanceEntry, dirs: ReturnType<typeof computer>): string => {
    const base = instanceEntryPath(entry, dirs);
    if (entry.type === "file") return base;
    const sample = { nodes: "a-node.token", memory: "topic-1.md", media: "photo.png", uploads: "doc.pdf", "context-files": "topic-1/notes.txt", views: "view-1.json", "claude-transcripts": "11111111.jsonl" }[entry.prefix === "state" ? entry.path : entry.prefix];
    return join(base, sample!);
  };

  test("the sender ships it, the receiver accepts it and restores it owner-only", async () => {
    const from = computer("from");
    const to = computer("to");
    for (const entry of INSTANCE_ENTRIES) {
      const file = sampleOf(entry, from);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, `content of ${entry.prefix}/${entry.path}`);
    }
    const db = new Database(from.dbPath);
    open.push(db);
    db.exec(`CREATE TABLE tasks (id TEXT); CREATE TABLE topics (id TEXT); CREATE TABLE messages (id INTEGER);`);
    const copy = join(from.stateDir, "outgoing", DB_NAME);
    const counts = snapshotDatabase(db, copy);

    const sources = [{ name: DB_NAME, source: copy }, ...collectStateFiles(from), ...collectAttachmentFiles(from)];
    const files: SwitchManifest["files"] = [];
    for (const s of sources) {
      const bytes = new Uint8Array(readFileSync(s.source));
      writeIncomingChunk(to.stateDir, s.name, 0, bytes);
      files.push({ name: s.name, size: bytes.byteLength, sha256: await sha256File(s.source) });
    }
    // Every entry has a file in the bundle, under the name its prefix gives, and the receiver's closed list accepts it.
    for (const entry of INSTANCE_ENTRIES) {
      const sample = sampleOf(entry, from);
      const rel = relative(instanceEntryPath({ ...entry, path: "" }, from), sample).split("\\").join("/");
      const name = `${entry.prefix}/${rel}`;
      expect(files.map((f) => f.name)).toContain(name);
      expect(isSafeBundleName(name)).toBe(true);
    }

    const manifest: SwitchManifest = { version: 1, epoch: 1, toMachineId: "m-to", toHostname: "to-host", fromMachineId: "m-from", createdAt: "2026-01-01T00:00:00.000Z", counts, files };
    expect((await commitIncoming(to.stateDir, manifest, { hostname: "to-host", epoch: 0, freeBytes: () => Number.MAX_SAFE_INTEGER })).ok).toBe(true);
    expect(applyPendingPrimaryChange({ ...to, log: () => {} })).toBe("restored");

    for (const entry of INSTANCE_ENTRIES) {
      const restored = sampleOf(entry, to);
      expect(readFileSync(restored, "utf-8")).toBe(`content of ${entry.prefix}/${entry.path}`);
      // Owner-only like the node tokens: the VAPID private key signs every push this machine sends.
      if (process.platform !== "win32") expect(statSync(restored).mode & 0o777).toBe(0o600);
    }
  });
});
