/**
 * The kept name of a CLI transcript outlives the CLI's 30-day cleanup.
 *
 * 22/10: `d1a77950….jsonl`, a chat idle since 22/09, vanished between two boots
 * and the next boot forgot the session. These run on a real filesystem: the
 * cleanup is an `unlink` of the CLI's name, nothing else. Bun's `homedir()`
 * does not follow a HOME set at runtime, so transcripts land under the real
 * `~/.claude/projects`, in folders named after this test's temp dir, with fresh
 * ids, and each test removes its folders. *
 * @covers RESUME-05
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { claudeProjectDirName, claudeTranscriptPath } from "./claude-transcript-path";
import { keepLiveTranscripts, keepTranscript, keeperDirFor, restoreSweptTranscript, restoreTranscript } from "./transcript-keeper";

let ID = "";
let root = "";

beforeEach(() => {
  ID = crypto.randomUUID();
  root = mkdtempSync(join(tmpdir(), "transcript-keeper-"));
  mkdirSync(join(root, "project"), { recursive: true });
});

afterEach(() => {
  const cwd = join(root, "project");
  for (const name of new Set([claudeProjectDirName(cwd), claudeProjectDirName(realpathSync(cwd))])) {
    rmSync(join(homedir(), ".claude", "projects", name), { recursive: true, force: true });
  }
  rmSync(root, { recursive: true, force: true });
});

/** Where the CLI writes it: under the RESOLVED cwd (the temp dir sits behind a symlink on macOS). */
function writeTranscript(cwd: string, id: string, lines: string[]): string {
  const path = claudeTranscriptPath(realpathSync(cwd), id);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, lines.map((l) => `${l}\n`).join(""));
  return path;
}

function dbWith(rows: { chat?: { sk: string; id: string; archived?: number; path?: string | null }[]; tabs?: { id: string; cwd: string; csid: string }[] }) {
  const db = new Database(join(root, "data", "topics.db"), { create: true });
  db.run("CREATE TABLE topics (id TEXT, session_key TEXT, archived INTEGER)");
  db.run("CREATE TABLE claude_code_sessions (session_key TEXT, claude_session_id TEXT, jsonl_path TEXT)");
  db.run("CREATE TABLE terminal_sessions (id TEXT, cwd TEXT, claude_session_id TEXT)");
  for (const c of rows.chat ?? []) {
    db.run("INSERT INTO topics VALUES (?, ?, ?)", [c.sk, c.sk, c.archived ?? 0]);
    db.run("INSERT INTO claude_code_sessions VALUES (?, ?, ?)", [c.sk, c.id, c.path ?? null]);
  }
  for (const t of rows.tabs ?? []) db.run("INSERT INTO terminal_sessions VALUES (?, ?, ?)", [t.id, t.cwd, t.csid]);
  return db;
}

describe("transcript keeper", () => {
  it("a kept transcript follows the CLI's appends and comes back whole after the cleanup", () => {
    mkdirSync(join(root, "data"), { recursive: true });
    const cwd = join(root, "project");
    const path = writeTranscript(cwd, ID, ['{"turn":1}']);
    const dir = join(root, "data", "claude-transcripts");
    expect(keepTranscript(dir, ID, path)).toBe("linked");
    appendFileSync(path, '{"turn":2}\n');
    expect(keepTranscript(dir, ID, path)).toBe("unchanged");

    unlinkSync(path); // the CLI's cleanup
    const back = restoreTranscript(dir, cwd, ID);
    expect(back).toEqual({ path, restored: true });
    expect(readFileSync(path, "utf8")).toBe('{"turn":1}\n{"turn":2}\n');
  });

  it("a transcript still in place is not touched, and one never kept is not invented", () => {
    const cwd = join(root, "project");
    const dir = join(root, "data", "claude-transcripts");
    const path = writeTranscript(cwd, ID, ['{"turn":1}']);
    const ino = statSync(path).ino;
    expect(restoreTranscript(dir, cwd, ID)).toEqual({ path, restored: false });
    expect(statSync(path).ino).toBe(ino);
    unlinkSync(path);
    expect(restoreTranscript(dir, cwd, ID)).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  it("an id that is not a session id never becomes a path", () => {
    const dir = join(root, "data", "claude-transcripts");
    const path = writeTranscript(join(root, "project"), ID, ["{}"]);
    expect(keepTranscript(dir, "../../etc/passwd", path)).toBe("invalid");
    expect(existsSync(dir)).toBe(false);
  });

  it("one pass keeps chats (archived ones too, they wake up) and tabs, and drops forgotten ones", () => {
    const cwd = join(root, "project");
    const chatId = ID;
    const archivedId = crypto.randomUUID();
    const tabId = crypto.randomUUID();
    const goneId = crypto.randomUUID();
    writeTranscript(cwd, chatId, ["{}"]);
    writeTranscript(cwd, archivedId, ["{}"]);
    writeTranscript(cwd, tabId, ["{}"]);
    mkdirSync(join(root, "data"), { recursive: true });
    const db = dbWith({
      chat: [{ sk: "topic:aaaa", id: chatId }, { sk: "topic:bbbb", id: archivedId, archived: 1 }],
      tabs: [{ id: "term-1", cwd, csid: tabId }],
    });
    const dir = keeperDirFor(db)!;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${goneId}.jsonl`), "{}\n");

    expect(keepLiveTranscripts(db)).toEqual({ kept: 3, pruned: 1 });
    expect(existsSync(join(dir, `${chatId}.jsonl`))).toBe(true);
    expect(existsSync(join(dir, `${tabId}.jsonl`))).toBe(true);
    expect(existsSync(join(dir, `${archivedId}.jsonl`))).toBe(true);
    expect(existsSync(join(dir, `${goneId}.jsonl`))).toBe(false);

    unlinkSync(claudeTranscriptPath(cwd, tabId));
    expect(restoreSweptTranscript(db, cwd, tabId, "test")).toBe(true);
    expect(existsSync(claudeTranscriptPath(cwd, tabId))).toBe(true);
    db.close();
  });

  it("a transcript put back is dated now, or the next CLI's cleanup deletes it again", () => {
    const cwd = join(root, "project");
    const dir = join(root, "data", "claude-transcripts");
    const path = writeTranscript(cwd, ID, ["{}"]);
    const old = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(path, old, old);
    keepTranscript(dir, ID, path);
    unlinkSync(path);
    restoreTranscript(dir, cwd, ID);
    expect(Date.now() - statSync(path).mtimeMs).toBeLessThan(60_000);
  });

  it("a transcript replaced by a rename (the CLI's compaction) is linked again, even at the same size", () => {
    const cwd = join(root, "project");
    const dir = join(root, "data", "claude-transcripts");
    const path = writeTranscript(cwd, ID, ["AAAA"]);
    keepTranscript(dir, ID, path);
    writeFileSync(`${path}.compact.tmp`, "BBBB\n");
    renameSync(`${path}.compact.tmp`, path);
    expect(keepTranscript(dir, ID, path)).toBe("linked");
    expect(readFileSync(join(dir, `${ID}.jsonl`), "utf8")).toBe("BBBB\n");
  });

  it("an unreadable session table drops no link", () => {
    mkdirSync(join(root, "data"), { recursive: true });
    const db = new Database(join(root, "data", "topics.db"), { create: true });
    const dir = keeperDirFor(db)!;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${ID}.jsonl`), "{}\n");
    expect(keepLiveTranscripts(db)).toEqual({ kept: 0, pruned: 0 });
    expect(existsSync(join(dir, `${ID}.jsonl`))).toBe(true);
    db.close();
  });

  it("an in-memory database keeps nothing and restores nothing", () => {
    const db = new Database(":memory:");
    expect(keeperDirFor(db)).toBeNull();
    expect(keepLiveTranscripts(db)).toEqual({ kept: 0, pruned: 0 });
    expect(restoreSweptTranscript(db, join(root, "project"), ID, "test")).toBe(false);
  });
});
