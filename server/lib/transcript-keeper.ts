/**
 * A second name for Claude CLI transcripts, out of reach of the CLI's own cleanup.
 *
 * WHY. Every Claude Code process, when it starts, deletes the transcripts of
 * sessions idle for more than `cleanupPeriodDays` (30 by default). Sessions born
 * in Claude Desktop are exempt; the ones Topics launches (`claude -p` for chats,
 * the CLI inside terminal tabs) are not. On 22/10, between 12:43 and 16:16, that
 * removed `d1a77950….jsonl`, the "Regia Claude · Backlog Topics" chat, idle since
 * 22/09 14:07: thirty days to the hour. The next boot's `orphan-transcript` sweep
 * saw the file missing and forgot the session, so its next turn would have
 * started from nothing but the DB recap instead of the model's memory.
 *
 * HOW. A hard link `<data>/claude-transcripts/<id>.jsonl` on the transcript's
 * inode. The CLI appends, so the link sees every new line without a copy; when
 * the cleanup removes the CLI's name the inode lives on through ours, and a
 * resume puts it back where `--resume` looks. Where a link cannot be made
 * (another volume) it is a copy, refreshed on each pass when the size changes.
 *
 * COST. Nothing while the CLI's file exists: two names, the same bytes. After a
 * cleanup, that session's bytes and no more. Only sessions Topics can still
 * resume are kept: every chat with a session row (an archived one included, it
 * wakes up when unarchived: lib/session-parking.ts) and terminal tabs with a
 * resume id. The link of a forgotten session goes on the next pass.
 *
 * A transcript put back gets a fresh mtime: with its old one the cleanup of the
 * next CLI that starts anywhere would delete it again before the resume.
 */
import type { Database } from "bun:sqlite";
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { claudeTranscriptCandidates, claudeTranscriptPath, findClaudeTranscript } from "./claude-transcript-path";

/** A CLI session id is a uuid. Nothing else ever becomes a file name here. */
const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/;

/** The links live next to the DB. Null for an in-memory DB (tests that do not want it). */
export function keeperDirFor(db: Database): string | null {
  const file = db.filename;
  if (!file || file === ":memory:") return null;
  return join(dirname(file), "claude-transcripts");
}

function keptPath(dir: string, sessionId: string): string | null {
  return SESSION_ID.test(sessionId) ? join(dir, `${sessionId}.jsonl`) : null;
}

/** A link (or copy) put in place in one rename: never a half file under the final name. */
function placeAt(source: string, target: string): "linked" | "copied" {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.tmp`;
  try { unlinkSync(tmp); } catch { /* not there */ }
  let how: "linked" | "copied" = "linked";
  try {
    linkSync(source, tmp);
  } catch {
    copyFileSync(source, tmp);
    how = "copied";
  }
  renameSync(tmp, target);
  return how;
}

export type KeepResult = "linked" | "copied" | "unchanged" | "missing" | "invalid";

/**
 * Keeps `transcript` under `dir`. Idempotent: a link on the same inode, or a copy
 * as large and not older than the source, is left alone. Size alone is not
 * enough: the CLI compacts a large transcript by writing a new file and renaming
 * it over the old one, and a new inode of equal size must be linked again.
 */
export function keepTranscript(dir: string, sessionId: string, transcript: string): KeepResult {
  const kept = keptPath(dir, sessionId);
  if (!kept) return "invalid";
  let src;
  try { src = statSync(transcript); } catch { return "missing"; }
  try {
    const cur = statSync(kept);
    if (cur.ino === src.ino && cur.dev === src.dev) return "unchanged";
    if (cur.nlink === 1 && cur.size === src.size && cur.mtimeMs >= src.mtimeMs) return "unchanged";
  } catch { /* not kept yet */ }
  return placeAt(transcript, kept);
}

/**
 * Puts the transcript back where `--resume` looks for it, when the CLI deleted
 * it and Topics kept a name. Returns its path when it exists after the call
 * (it was there, or it was put back), null when it is nowhere.
 */
export function restoreTranscript(dir: string, cwd: string, sessionId: string): { path: string; restored: boolean } | null {
  const present = findClaudeTranscript(cwd, sessionId);
  if (present) return { path: present, restored: false };
  const kept = keptPath(dir, sessionId);
  if (!kept || !existsSync(kept)) return null;
  // The CLI files a session under its RESOLVED cwd (`/tmp` is `/private/tmp`):
  // the first candidate. `claudeTranscriptPath` answers the raw name when
  // nothing exists yet, which is where the CLI would not look.
  const target = claudeTranscriptCandidates(cwd, sessionId)[0]!;
  placeAt(kept, target);
  const now = new Date();
  utimesSync(target, now, now);
  return { path: target, restored: true };
}

/**
 * The door the resume points use (chat spawn, terminal tab, boot sweep): never
 * throws, logs one line when it puts something back, does nothing without an
 * on-disk DB.
 */
export function restoreSweptTranscript(db: Database | null, cwd: string | null | undefined, sessionId: string | null | undefined, who: string): boolean {
  if (!db || !cwd || !sessionId) return false;
  const dir = keeperDirFor(db);
  if (!dir) return false;
  try {
    const r = restoreTranscript(dir, cwd, sessionId);
    if (r?.restored) {
      console.log(`[transcript-keeper] ${who}: transcript ${sessionId.slice(0, 8)} deleted by the CLI cleanup, put back at ${r.path}`);
      return true;
    }
  } catch (err) {
    console.warn(`[transcript-keeper] ${who}: could not put back transcript ${sessionId.slice(0, 8)}:`, err);
  }
  return false;
}

interface LiveSession { id: string; known: Array<string | null | undefined> }

/**
 * The sessions Topics can still resume, with the paths where their transcript
 * should be. Null when a table could not be read: the caller must then not
 * prune, or one failed query would drop every link.
 */
function liveSessions(db: Database): LiveSession[] | null {
  const out = new Map<string, LiveSession>();
  const add = (id: string | null, path: string | null | undefined) => {
    if (!id || !SESSION_ID.test(id)) return;
    const s = out.get(id) ?? { id, known: [] };
    s.known.push(path);
    out.set(id, s);
  };
  try {
    const chats = db.query(
      `SELECT claude_session_id AS id, jsonl_path AS path
         FROM claude_code_sessions WHERE claude_session_id IS NOT NULL`,
    ).all() as Array<{ id: string | null; path: string | null }>;
    for (const r of chats) add(r.id, r.path);
  } catch {
    return null;
  }
  try {
    const tabs = db.query(
      `SELECT claude_session_id AS id, cwd FROM terminal_sessions WHERE claude_session_id IS NOT NULL`,
    ).all() as Array<{ id: string | null; cwd: string | null }>;
    for (const r of tabs) {
      let path: string | null = null;
      if (r.cwd && r.id) { try { path = claudeTranscriptPath(r.cwd, r.id); } catch { /* unreadable cwd */ } }
      add(r.id, path);
    }
  } catch {
    return null;
  }
  return [...out.values()];
}

/**
 * Where each of `ids` sits under `~/.claude/projects`, from one read of every
 * project folder: per-id `existsSync` over ~800 folders cost 8.6 ms an id.
 */
function locateTranscripts(ids: Set<string>): Map<string, string> {
  const found = new Map<string, string>();
  if (ids.size === 0) return found;
  const root = join(homedir(), ".claude", "projects");
  let dirs: string[] = [];
  try { dirs = readdirSync(root); } catch { return found; }
  for (const dir of dirs) {
    let names: string[];
    try { names = readdirSync(join(root, dir)); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -".jsonl".length);
      if (ids.has(id) && !found.has(id)) found.set(id, join(root, dir, name));
    }
  }
  return found;
}

/**
 * One pass: keeps the transcript of every resumable session and drops the links
 * of sessions Topics will not resume. Runs at boot and every few hours: the CLI
 * cleanup needs thirty idle days, so any pass after a session is born is enough.
 */
export function keepLiveTranscripts(db: Database): { kept: number; pruned: number } {
  const dir = keeperDirFor(db);
  if (!dir) return { kept: 0, pruned: 0 };
  const live = liveSessions(db);
  if (!live) {
    console.warn("[transcript-keeper] session tables unreadable: nothing kept, nothing dropped");
    return { kept: 0, pruned: 0 };
  }
  const known = new Map<string, string>();
  for (const s of live) {
    const p = s.known.find((x): x is string => !!x && existsSync(x));
    if (p) known.set(s.id, p);
  }
  const located = locateTranscripts(new Set(live.map((s) => s.id).filter((id) => !known.has(id))));
  let kept = 0;
  for (const s of live) {
    const transcript = known.get(s.id) ?? located.get(s.id);
    if (!transcript) continue;
    try {
      const r = keepTranscript(dir, s.id, transcript);
      if (r === "linked" || r === "copied") kept++;
    } catch (err) {
      console.warn(`[transcript-keeper] could not keep ${s.id.slice(0, 8)}:`, err);
    }
  }
  let pruned = 0;
  const ids = new Set(live.map((s) => s.id));
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { /* folder not created yet */ }
  for (const name of names) {
    if (!name.endsWith(".jsonl") || ids.has(name.slice(0, -".jsonl".length))) continue;
    try { unlinkSync(join(dir, name)); pruned++; } catch { /* already gone */ }
  }
  return { kept, pruned };
}
