import { existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { writeFileAtomic } from "../lib/atomic-write";
import { readJsonStateFile } from "../lib/state-file";
import { resolveStateDir, stateDirTarget } from "../lib/data-dir";
import { readFileEnd } from "../lib/file-tail";
import { watchPidExits } from "../lib/pid-liveness";
import { commandServiceWatch, finishCommand, requestWakeFor } from "./processes-commands";
import { addToRecent, flushPendingLine, followLog, resumeFollow } from "./processes-output";
import { broadcastScriptsUpdate } from "./processes-snapshot";
import { MAX_OUTPUT_BYTES, type PersistedScript, type ScriptProcess, recentScripts, runningScripts, _broadcastCtx, setScriptsResponseCache } from "./processes-state";

// ── Persistence ──────────────────────────────────────────────────────────────

/**
 * The registry's folder, resolved again whenever the variables that name it
 * change. Fixed at the first import, it outlived them: `bun test` runs many
 * files in one process, the first file that loaded the registry named the
 * folder, and once the per-file sweep removed that file's root a later file's
 * commands opened their logs and their `scripts.json` in a folder that was
 * gone (18 reds in process-run-command.test.ts after chat-woken-turn, 28/09).
 * The folder goes through the one door, and is remembered keyed on what that
 * door reads (`stateDirTarget`): `resolveStateDir` creates the folder and
 * probes it for writing on every call, and a script's log is written from here
 * once per output chunk. So the folder is resolved and created once per
 * target, and again only when the variables name another one.
 */
let persistDir: { target: string; dir: string } | null = null;

export function getPersistDir(): string {
  const target = stateDirTarget(process.cwd());
  if (persistDir?.target !== target) {
    const dir = join(resolveStateDir(process.cwd()), ".state");
    mkdirSync(join(dir, "scripts"), { recursive: true });
    persistDir = { target, dir };
  }
  return persistDir.dir;
}

function persistPath(): string {
  return join(getPersistDir(), "scripts.json");
}

export function saveState() {
  invalidateScriptsCache();
  const data = {
    // Detected processes are ephemeral (re-discovered every detector cycle) and
    // were not spawned by us, so never persist them — only Topics-launched scripts.
    // Le shell in background stanno nella stessa categoria, e in più: un pid
    // scritto su disco e riletto dopo un riavvio può essere stato riciclato dal
    // sistema, e ci si appenderebbe un bottone «Stop».
    // A command is Topics' own child like a script: it is re-adopted after a
    // restart the same way, and its metadata says whom to wake.
    running: Array.from(runningScripts.values()).filter(sp => !sp.source || sp.source === "script" || sp.cmd).map(persisted),
    recent: recentScripts.map(persisted),
  };
  // tmp + rename: in place, a kill between truncate and write emptied the file
  // and the next boot lost every re-adoptable process and owed wake with it.
  try { writeFileAtomic(persistPath(), JSON.stringify(data)); }
  catch (err) { console.warn(`[processes] saving ${persistPath()} failed:`, err); }
}

function persisted(sp: ScriptProcess): PersistedScript {
  return {
    processId: sp.processId, scriptName: sp.scriptName, command: sp.command,
    projectPath: sp.projectPath, status: sp.status, pid: sp.pid, pidLstart: sp.pidLstart,
    startedAt: sp.startedAt, completedAt: sp.completedAt, exitCode: sp.exitCode,
    ...(sp.cmd ? { source: "command" as const, cmd: { ...sp.cmd, closing: undefined } } : {}),
    ...(sp.cardRun ? { cardRun: sp.cardRun } : {}),
  };
}

/** Where a process's log lives. Exported for the tests. */
export const logPathOf = (processId: string) => join(getPersistDir(), "scripts", `${processId}.log`);
export const exitPathOf = (processId: string) => join(getPersistDir(), "scripts", `${processId}.exit`);

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
 * `ps -o lstart=` per un pid, sincrono. `undefined` se il pid non c'e' piu'.
 *
 * Synchronous because `loadState()` runs inside synchronous callers (the
 * boot, and any export that reads the registry first), with no promise to
 * wait on, and it is one `ps` per re-adopted script.
 * `getPidStartTimes` e' il gemello asincrono e in blocco della strada di kill.
 */
export function pidStartTime(pid: number): string | undefined {
  try {
    const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { timeout: 3000, killSignal: "SIGKILL" });
    const out = new TextDecoder().decode(result.stdout).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Riadottare o no uno script `running` letto dal disco.
 *
 * IL PID DA SOLO NON E' UN'IDENTITA'. Il server puo' restare giu' ore, e in
 * quel tempo il sistema ricicla i numeri: riadottare per numero significa
 * mettere in pannello un processo di qualcun altro con sopra un bottone Stop
 * che gli manda SIGTERM. Il commento di `saveState` nomina questo pericolo da
 * sempre; qui c'e' la difesa. Lo stesso disambiguatore (`lstart`) che la strada
 * di kill usa per il SIGKILL ritardato.
 *
 * Senza timbro si RINUNCIA, e non e' pignoleria: uno stato scritto prima del
 * fix non puo' dimostrare la propria identita', e sbagliare verso qui vuol dire
 * ammazzare un estraneo. Costa una riga «error» per un boot solo.
 *
 * Puro (la sonda si passa) perche' la corsa che descrive non si riproduce: un
 * pid riciclato non si fabbrica a comando.
 */
export function readoptVerdict(args: {
  pid: number | null | undefined;
  pidLstart?: string;
  probe: (pid: number) => string | undefined;
}): "adopt" | "dead" {
  if (!args.pid || args.pid <= 0) return "dead";
  const live = args.probe(args.pid);
  if (live === undefined) return "dead"; // il pid non esiste piu'
  if (!args.pidLstart) return "dead";    // non possiamo provare che sia lo stesso
  return live === args.pidLstart ? "adopt" : "dead";
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

/**
 * Whether this process has read its persisted registry. Set before the read,
 * not after: `loadState` closes a command found dead, closing saves, and a
 * save from inside the load must not start a second one.
 */
let registryLoaded = false;

/**
 * Read the registry persisted under the state folder, once per process: the
 * runs of the previous life re-adopted, the ones that ended while the server
 * was down closed and their wakes requested. `server.ts` calls it at boot,
 * after the daemon lock and before `createAppContext`; every export that reads
 * or changes the registry calls it too, so whoever comes first loads it and
 * nobody sees an empty registry that has a file on disk.
 *
 * WHY NOT AT IMPORT, where it used to run. The state folder is a function of
 * the environment (`stateDirTarget`), and at import the environment is not yet
 * the caller's. A test file imports `./chat` at its top, `chat.ts` imports this
 * module, and ES imports run before the file's `beforeAll` can point DATA_DIR
 * at a temporary folder: 64 test files run from the repo resolved the folder
 * to the working directory, created `.state/scripts/` there and read the LIVE
 * `scripts.json`, re-adopting the running server's commands and rewriting the
 * file when one of them had ended (04/10/2026). The same import also made a
 * server that loses the daemon lock rewrite that file before exiting, which
 * `server.ts` says a losing boot must not do. Guard:
 * `processes.import-touches-nothing.test.ts`.
 *
 * Production resolves the same folder as before: the variables are the same
 * and nothing between the imports and this call changes them.
 */
export function loadProcessRegistry(): void {
  if (registryLoaded) return;
  registryLoaded = true;
  loadState();
  // getPersistDir() resolves a writable dir, but keep this defensive so a
  // persist-dir failure can never abort server boot and hang the "Launching
  // the local engine" splash.
  try {
    mkdirSync(join(getPersistDir(), "scripts"), { recursive: true });
  } catch (e) {
    console.error("[processes] persist dir init failed (non-fatal):", e);
  }
}

// ── Scripts response cache (2s TTL, invalidated on state change) ─────────
// (The cache itself is declared at the top: `loadState` can close a
// command's row, which saves, which invalidates it.)
export const SCRIPTS_CACHE_TTL = 2000;

export function invalidateScriptsCache() {
  setScriptsResponseCache(null);
}
