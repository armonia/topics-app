import { existsSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { readJsonStateFile } from "../lib/state-file";
import { readFileEnd } from "../lib/file-tail";
import { watchPidExits } from "../lib/pid-liveness";
import { commandServiceWatch, finishCommand, requestWakeFor } from "./processes-commands";
import { addToRecent, flushPendingLine, followLog, resumeFollow } from "./processes-output";
import { getPersistDir, logPathOf, persistPath, pidStartTime, readoptVerdict, saveState, setRegistryRestore } from "./processes-persist";
import { broadcastScriptsUpdate } from "./processes-snapshot";
import { MAX_OUTPUT_BYTES, type PersistedScript, type ScriptProcess, recentScripts, runningScripts, _broadcastCtx } from "./processes-state";

// ── Restore of the persisted registry ────────────────────────────────────────

/**
 * The process's log file back into its buffer: its last MAX_OUTPUT_BYTES, read
 * without reading the rest (`readFileEnd`), a trailing line without its newline
 * kept pending (a live command may be in the middle of it). Returns the file's
 * size, which is where a tail resumes, or null when there is no file.
 */
function loadLogFile(sp: ScriptProcess): number | null {
  try {
    const end = readFileEnd(logPathOf(sp.processId), MAX_OUTPUT_BYTES);
    if (!end) return null;
    const lines = end.text.split("\n");
    sp.pendingLine = lines.pop() ?? "";
    sp.output = lines;
    sp.outputBytes = end.text.length;
    return end.size;
  } catch {
    return null;
  }
}

function loadState() {
  // A torn file is logged and kept aside, not dropped in silence (lib/state-file.ts).
  const data = readJsonStateFile(persistPath(), "processes") as { running?: unknown; recent?: unknown } | null;
  if (!data) return;
  try {

    // Restore recent scripts (completed ones)
    if (Array.isArray(data.recent)) {
      for (const r of data.recent) {
        const sp: ScriptProcess = {
          ...r,
          ...(r.cmd ? { cmd: { ...r.cmd, closing: false } } : {}),
          output: [],
          outputBytes: 0,
          proc: null,
        };
        loadLogFile(sp);
        flushPendingLine(sp);
        recentScripts.push(sp);
        if (sp.cmd?.wake) requestWakeFor(sp);
      }
    }

    // For "running" scripts from a previous server session:
    // Check if the PID is still alive. If yes, re-adopt; if no, mark as error.
    // Commands found dead are closed AFTER the loop: `finishCommand` saves the
    // registry, and a save from inside the loop wrote a `scripts.json` without
    // the rows not yet reached, which the next reload then lost.
    const endedCommands: ScriptProcess[] = [];
    if (Array.isArray(data.running)) {
      for (const r of data.running as PersistedScript[]) {
        if (readoptVerdict({ pid: r.pid, pidLstart: r.pidLstart, probe: pidStartTime }) === "adopt") {
          // Process is still alive — re-track it (we can't re-capture stdout,
          // but we can track its PID for port detection and stop)
          const sp: ScriptProcess = {
            ...r,
            ...(r.cmd ? { cmd: { ...r.cmd, closing: false } } : {}),
            status: "running",
            output: [],
            outputBytes: 0,
            proc: null, // We don't have the handle, but we have the PID
          };
          const logBytes = loadLogFile(sp);
          if (logBytes === null) {
            sp.output = ["[server restarted: previous output lost]"];
            sp.outputBytes = 40;
          }
          runningScripts.set(r.processId, sp);
          // A command's log is written by the command itself, so what it printed
          // while the server was down is in the file: follow it from there on.
          // The same for the file it sends its stdout to.
          if (sp.cmd) { followLog(sp, logPathOf(sp.processId), logBytes ?? 0); resumeFollow(sp); }
          if (sp.cmd && !sp.cmd.wake) commandServiceWatch.kick();

          // Poll for exit in background
          pollPidExit(sp);
        } else if (r.cmd) {
          // A command that ended while the server was down: its log and its
          // exit file say how, and the topic may still be owed its wake.
          const sp: ScriptProcess = { ...r, status: "running", output: [], outputBytes: 0, proc: null };
          if (sp.cmd) sp.cmd.closing = false;
          loadLogFile(sp);
          resumeFollow(sp);
          runningScripts.set(r.processId, sp);
          endedCommands.push(sp);
        } else {
          // Process died while server was down
          const sp: ScriptProcess = {
            ...r,
            status: "error",
            completedAt: r.completedAt || new Date().toISOString(),
            exitCode: r.exitCode ?? -1,
            output: [],
            outputBytes: 0,
            proc: null,
          };
          loadLogFile(sp);
          addToRecent(sp);
        }
      }
    }
    for (const sp of endedCommands) finishCommand(sp, { foundDead: true });

    // Cleanup old log files for completed processes older than 7 days. Not
    // those of a command closed at this boot, however old (the server was off
    // a week): they go at the next sweep, once its row is closed.
    const closedNow = new Set(endedCommands.map((sp) => sp.processId));
    try {
      const scriptsDir = join(getPersistDir(), "scripts");
      if (existsSync(scriptsDir)) {
        const now = Date.now();
        const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
        for (const file of readdirSync(scriptsDir)) {
          // `.exit` is a command's exit code, beside its log (`command-process.ts`).
          if (!file.endsWith('.log') && !file.endsWith('.exit')) continue;
          const processId = file.replace(/\.(log|exit)$/, '');
          // Keep logs for running processes
          if (runningScripts.has(processId) || closedNow.has(processId)) continue;
          // Check if recent and not old
          const recent = recentScripts.find(s => s.processId === processId);
          if (recent?.completedAt && (now - new Date(recent.completedAt).getTime()) < SEVEN_DAYS) continue;
          // Remove old log
          try { unlinkSync(join(scriptsDir, file)); } catch { /* best-effort cleanup: the log may already be gone, the next sweep retries */ }
        }
      }
    } catch { /* best-effort cleanup: an unreadable scripts dir is retried at the next sweep */ }
  } catch (err) {
    console.error(`[processes] restoring the registry from ${persistPath()} failed:`, err);
  }
}

/**
 * A re-adopted row has no handle whose exit it could wait on: its pid is checked
 * every 3 s, all rows in one round with one probe (`watchPidExits`), where each
 * row used to run its own synchronous `ps` and stop the loop with it.
 */
const pollPidExit = watchPidExits<ScriptProcess>({
  everyMs: 3000,
  pidOf: (sp) => sp.pid,
  settled: (sp) => !!sp.cmd && sp.status !== "running", // a Stop already closed it
  onGone: (sp) => {
    if (sp.cmd) { finishCommand(sp); return; }
    sp.status = "done";
    sp.completedAt = new Date().toISOString();
    sp.proc = null;
    runningScripts.delete(sp.processId);
    addToRecent(sp);
    saveState();
    if (_broadcastCtx) broadcastScriptsUpdate(_broadcastCtx);
  },
});

setRegistryRestore(loadState);
