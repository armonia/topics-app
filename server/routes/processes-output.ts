import { statSync } from "fs";
import { appendFile as appendFileAsync, readFile as readFileAsync, writeFile as writeFileAsync } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { writeFileAtomic } from "../lib/atomic-write";
import { appendToLogBuffer, flushLogBuffer } from "../lib/log-cursor";
import { stripAnsi } from "../utils/path-env";
import { openTail, readTail, shrinkLog } from "../lib/file-tail";
import { stdoutTargetOf } from "../lib/command-redirect";
import { noteRunAlive } from "../lib/command-runs";
import { getPersistDir, logPathOf } from "./processes-persist";
import { notifyScriptOutput } from "./processes-snapshot";
import { type CommandMeta, MAX_LOG_FILE_BYTES, MAX_OUTPUT_BYTES, MAX_RECENT, type ScriptProcess, isPersonRun, recentScripts, runningScripts, _broadcastCtx, tailTimer, setTailTimer } from "./processes-state";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Chiude la riga rimasta in sospeso.
 *
 * Un processo può morire senza aver mai scritto l'ultimo `\n` — un errore
 * stampato e via. Senza questa chiusura quella riga resterebbe nel residuo per
 * sempre: visibile finché il processo è in memoria, persa nel log ricaricato.
 */
export function flushPendingLine(sp: ScriptProcess) {
  const buf = {
    output: sp.output,
    outputBytes: sp.outputBytes,
    droppedLines: sp.droppedLines ?? 0,
    pendingLine: sp.pendingLine ?? "",
  };
  flushLogBuffer(buf);
  sp.output = buf.output;
  sp.outputBytes = buf.outputBytes;
  sp.pendingLine = buf.pendingLine;
}

export function addToRecent(sp: ScriptProcess) {
  flushPendingLine(sp);
  recentScripts.unshift(sp);
  trimRecent();
}

/**
 * The oldest rows past MAX_RECENT go, but not one that still owes its topic a
 * wake (`scripts.json` persists only these rows, so a pruned owed row lost its
 * wake at the next reload; scripts and every agent's shells end here too, and
 * ten endings go by fast), nor a person's run before the router has a
 * database to close its `command_runs` row in: more than ten found dead at one
 * boot evicted the oldest unclosed, and its row then closed as unknown. Both
 * are pruned normally once settled.
 */
export function trimRecent(): void {
  for (let i = recentScripts.length - 1; recentScripts.length > MAX_RECENT && i >= 0; i--) {
    const sp = recentScripts[i]!;
    if (!sp.cmd?.wake && !(isPersonRun(sp) && !_broadcastCtx)) recentScripts.splice(i, 1);
  }
}

/**
 * @param whole `true` quando `text` è un blocco COMPLETO e non un frammento di
 *   stream. I chunk di `proc.stdout` arrivano tagliati dove capita, e l'ultima
 *   riga senza `\n` va tenuta in sospeso finché non arriva il resto. Un
 *   `BashOutput` di un agente, invece, è una fotografia intera: trattenerne
 *   l'ultima riga la renderebbe invisibile fino al blocco successivo, che può
 *   non arrivare mai.
 */
export function appendOutput(sp: ScriptProcess, text: string, whole = false) {
  if (!text) return;
  // La parte pura — taglio delle righe, riga in sospeso, potatura e conteggio
  // di ciò che è stato buttato — vive in `lib/log-cursor.ts`, dov'è coperta da
  // test. Qui resta solo la persistenza su disco.
  const buf = {
    output: sp.output,
    outputBytes: sp.outputBytes,
    droppedLines: sp.droppedLines ?? 0,
    pendingLine: sp.pendingLine ?? "",
  };
  appendToLogBuffer(buf, text, MAX_OUTPUT_BYTES, whole);
  sp.output = buf.output;
  sp.outputBytes = buf.outputBytes;
  sp.droppedLines = buf.droppedLines;
  sp.pendingLine = buf.pendingLine;
  // A file-backed log is somebody else's file: writing it too would print
  // every line twice after the next reload.
  if (sp.tail || sp.cmd) return;
  // Persist to log file — async, serialized per process. The old
  // appendFileSync + statSync (and readFileSync+writeFileSync on rotation)
  // blocked Bun's single event loop once per stdout/stderr chunk. The chain
  // keeps appends and rotation ordered; rotation is triggered off the
  // in-memory byte counter, so the write path never stats the file.
  const logPath = join(getPersistDir(), "scripts", `${sp.processId}.log`);
  sp.logQueue = (sp.logQueue ?? Promise.resolve())
    .then(async () => {
      await appendFileAsync(logPath, text);
      sp.logBytes = (sp.logBytes ?? 0) + Buffer.byteLength(text);
      // Rotation: past the limit, keep the last MAX_OUTPUT_BYTES
      if (sp.logBytes > MAX_LOG_FILE_BYTES) {
        const content = await readFileAsync(logPath);
        await writeFileAsync(logPath, content.subarray(Math.max(0, content.length - MAX_OUTPUT_BYTES)));
        sp.logBytes = Math.min(content.length, MAX_OUTPUT_BYTES);
      }
    })
    .catch(() => {});
}

// ── File-backed logs: commands and the CLI's shells ─────────────────────────

/** Follow `path` from `offset` into the row's buffer, once a second. */
export function followLog(sp: ScriptProcess, path: string, offset: number): void {
  sp.tail = openTail(path, offset);
  if (!tailTimer) {
    const timer = setInterval(tickTails, 1000);
    setTailTimer(timer);
    (timer as { unref?: () => void }).unref?.();
  }
}

/**
 * Read what the file gained into the buffer. True when there was something.
 * A command's own log is then cut to the same size a script's is rotated to;
 * a shell's file is the CLI's, and stays as the CLI wrote it.
 */
export function pumpTail(sp: ScriptProcess): boolean {
  const followed = pumpFollow(sp);
  if (!sp.tail) return followed;
  const { text, skipped } = readTail(sp.tail);
  if (skipped) appendOutput(sp, `[${skipped} bytes of output skipped]\n`);
  if (text) appendOutput(sp, text);
  if (sp.cmd && sp.tail.offset > MAX_LOG_FILE_BYTES) shrinkLog(sp.tail, MAX_OUTPUT_BYTES);
  return !!(text || skipped) || followed;
}

// ── The file a command sends its stdout to (chat-live-work) ─────────────────

/**
 * What a command names as its stdout, read before it starts. `from`: 0 when the
 * shell truncates the file, its size now when it appends, since what is there
 * already is an earlier run's. `cwd` is where it runs; a row persisted before
 * this field existed only has its project, which is where it ran by default.
 */
export function followOf(command: string, cwd: string): Pick<CommandMeta, "follow" | "unfollowed"> {
  const target = stdoutTargetOf(command, { cwd, home: homedir() });
  if (!target) return {};
  if (target.kind === "unresolved") return { unfollowed: { target: target.target, reason: target.reason } };
  let from = 0;
  if (target.append) { try { from = statSync(target.path).size; } catch { /* not there yet: from its start */ } }
  return { follow: { path: target.path, from } };
}

/**
 * A regular file, or not yet there. Anything else is never opened: a FIFO
 * would block the open, and with it the server, until somebody writes into it.
 */
function followable(path: string): boolean | null {
  try { return statSync(path).isFile(); } catch { return null; }
}

/**
 * Lines of the followed file into the buffer, whole: its last line waits in
 * `followPending` for its newline, and the log's own pending line stays after
 * them. Two sources writing half lines into one buffer glued a line of one to
 * a line of the other.
 */
function insertFollowed(sp: ScriptProcess, text: string): void {
  const chunk = (sp.followPending ?? "") + text;
  const cut = chunk.lastIndexOf("\n");
  sp.followPending = chunk.slice(cut + 1);
  if (cut < 0) return;
  const own = sp.pendingLine ?? "";
  sp.pendingLine = "";
  appendOutput(sp, chunk.slice(0, cut + 1));
  sp.pendingLine = own;
}

/** What the followed file gained. True when there was something. Never throws: it runs in the tick of every row. */
function pumpFollow(sp: ScriptProcess): boolean {
  const tail = sp.followTail;
  if (!tail) return false;
  try {
    const kind = followable(tail.path);
    if (kind === null) return false;
    if (!kind) { sp.followTail = undefined; return false; }
    const { text, skipped } = readTail(tail);
    if (skipped) insertFollowed(sp, `[${skipped} bytes of output skipped]\n`);
    if (text) insertFollowed(sp, text);
    return !!(text || skipped);
  } catch (err) {
    console.warn(`[processes] following ${tail.path} for ${sp.processId} failed:`, err);
    sp.followTail = undefined;
    return false;
  }
}

/** A fresh command: its stdout file is followed from where this run starts. */
export function startFollow(sp: ScriptProcess): void {
  const f = sp.cmd?.follow;
  if (f) sp.followTail = openTail(f.path, f.from);
}

/**
 * A re-adopted command's file back into its buffer, the same resume as its log
 * (CMDRUN-03): what this run wrote, its last MAX_OUTPUT_BYTES at most, then
 * followed from the end. The file is read again because what the command
 * printed while the server was down is there. A row persisted before `follow`
 * existed gets one now: Muse's run of 07/10 was started before this code.
 */
export function resumeFollow(sp: ScriptProcess): void {
  const cmd = sp.cmd;
  if (!cmd) return;
  try {
    if (!cmd.follow && !cmd.unfollowed) Object.assign(cmd, followOf(sp.command, sp.projectPath));
    const f = cmd.follow;
    if (!f || followable(f.path) === false) return;
    let size = 0;
    try { size = statSync(f.path).size; } catch { /* not written yet */ }
    // Smaller than where the run started: truncated since, all of it is this run's.
    const start = size < f.from ? 0 : Math.max(f.from, size - MAX_OUTPUT_BYTES);
    sp.followTail = openTail(f.path, start);
    const { text } = readTail(sp.followTail);
    // Cut inside the file: its first line is a fragment.
    insertFollowed(sp, start > f.from && start > 0 ? text.slice(text.indexOf("\n") + 1) : text);
  } catch (err) {
    console.warn(`[processes] resuming the stdout file of ${sp.processId} failed:`, err);
    sp.followTail = undefined;
  }
}

/**
 * The command ended: the last of its file, its last line closed. Its log then
 * becomes what the panel showed, both files in the order they were read, so a
 * reload, which reads the log alone, still has the output that went to the
 * file. The command is gone, nobody else writes the log any more.
 */
export function endFollow(sp: ScriptProcess): void {
  if (!sp.cmd?.follow) return;
  pumpFollow(sp);
  if (sp.followPending) insertFollowed(sp, "\n");
  sp.followTail = undefined;
  sp.followPending = undefined;
  try { writeFileAtomic(logPathOf(sp.processId), [...sp.output, sp.pendingLine ?? ""].join("\n")); }
  catch (err) { console.warn(`[processes] saving the log of ${sp.processId} failed:`, err); }
}

/**
 * The line a row is printing now, for a one-line preview (`scripts:output`,
 * the chat's live work): the line being written, else the last one that is
 * not blank. A progress bar redraws its line with `\r`: its last drawing.
 */
export function lastLineOf(sp: ScriptProcess | undefined): string {
  if (!sp) return "";
  const clip = (line: string) => {
    const shown = stripAnsi(line.slice(line.lastIndexOf("\r", line.length - 2) + 1)).trim();
    return shown.length > 200 ? `${shown.slice(0, 199)}…` : shown;
  };
  for (const pending of [sp.followPending, sp.pendingLine]) if (pending && clip(pending)) return clip(pending);
  for (let i = sp.output.length - 1; i >= Math.max(0, sp.output.length - 50); i--) {
    const line = clip(sp.output[i] ?? "");
    if (line) return line;
  }
  return "";
}

function tickTails(): void {
  let live = 0;
  for (const sp of runningScripts.values()) {
    if (!sp.tail) continue;
    live++;
    // Still here, so still running: printing or silent, a person's run says so on its row.
    if (_broadcastCtx && isPersonRun(sp)) noteRunAlive(_broadcastCtx.db, sp.processId);
    if (!pumpTail(sp) || !_broadcastCtx) continue;
    notifyScriptOutput(_broadcastCtx, sp.processId);
  }
  if (!live && tailTimer) { clearInterval(tailTimer); setTailTimer(null); }
}
