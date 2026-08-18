import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { appendFile as appendFileAsync, readFile as readFileAsync, writeFile as writeFileAsync } from "fs/promises";
import { join } from "path";
import type { AppContext, RouteHandler } from "../types";
import { appendToLogBuffer, flushLogBuffer, sliceFromCursor } from "../lib/log-cursor";
import { detectScripts, resolveScript, MANIFESTS } from "../lib/project-scripts";
import { augmentEnv, wrapPty, stripAnsi } from "../utils/path-env";
import { resolveStateDir } from "../lib/data-dir";
import { getDescendantPids, getPidStartTimes } from "../lib/process-tree";
import { getTerminalSessionById } from "./terminal";
import { getSessionCliPid } from "../providers/session-pids";
import { backgroundShellBanner, shellProcessKey } from "../../shared/background-shell-registry";

interface ScriptProcess {
  processId: string;
  scriptName: string;
  command: string;
  projectPath: string;
  status: "running" | "done" | "error";
  pid: number | null;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  output: string[];       // circular buffer lines
  outputBytes: number;
  /**
   * Quante righe il ring buffer ha già BUTTATO. È l'origine del cursore
   * assoluto: senza, l'offset del client è un indice dentro un array che si
   * accorcia da sotto, e dopo un'eviction quell'indice indica un'altra riga.
   * Misurato: una riga sparisce in silenzio; nell'altro verso si duplicano
   * blocchi interi. Su un build verboso i 500KB si raggiungono in minuti.
   */
  droppedLines?: number;
  /**
   * L'ultima riga ANCORA senza `\n`. `text.split("\n")` su `"hello\n"` dà
   * `["hello", ""]`, e quell'elemento vuoto finiva nel buffer: due chunk
   * consecutivi producevano `hello\n\nworld`, cioè il log a interlinea doppia
   * che si vede aprendo qualsiasi processo. Simmetricamente un chunk tagliato a
   * metà riga diventava due righe.
   */
  pendingLine?: string;
  proc: ReturnType<typeof Bun.spawn> | null;
  /** Byte size of the on-disk .log — tracked in memory so the per-chunk write
   *  path never stats the file. The log is per-processId (unique per spawn),
   *  so it always starts at 0. Not persisted. */
  logBytes?: number;
  /** Per-process async write chain: keeps chunk appends + rotation ordered
   *  without blocking the event loop (the old appendFileSync/statSync ran on
   *  EVERY stdout/stderr chunk of every tracked script). Not persisted. */
  logQueue?: Promise<void>;
  /** 'script' = launched by Topics (run_script / UI), output captured. 'detected'
   *  = a listening server found under a Claude PTY that Topics did NOT spawn, so
   *  we have its pid/ports but not its stdout. 'shell' = una shell che l'agente
   *  ha lasciato in background con `Bash(run_in_background)`: il suo output
   *  arriva dai `BashOutput` dello stream, il pid dall'albero del CLI (3.5).
   *  Defaults to 'script'. */
  source?: "script" | "detected" | "shell";
  /**
   * `ps -o lstart=` del pid, catturato allo spawn. E' l'IDENTITA' del processo,
   * non un dettaglio: un pid da solo viene riciclato dal sistema, e riadottarlo
   * al boot per numero significa appendere il bottone Stop a un estraneo. Vedi
   * `readoptVerdict`. Persistito accanto al pid.
   */
  pidLstart?: string;
  /** Solo per `source: 'shell'`. */
  shell?: {
    /** L'id che il CLI usa nei suoi `BashOutput`/`KillShell`. */
    shellId: string;
    /** La sessione che l'ha avviata: chiude il cerchio con `session-pids`. */
    sessionKey: string;
    topicId: string | null;
    /** Pid del CLI padre — l'albero dentro cui cercare il processo vero. */
    ownerPid: number | null;
    /** Quante volte abbiamo provato a risolvere il pid senza riuscirci. Serve
     *  a smettere di frugare nella tabella dei processi per una shell che è
     *  morta prima ancora di essere vista. */
    resolveAttempts: number;
    /** Ultimo sottoalbero noto della shell (pid → lstart), catturato mentre era
     *  VIVA. È l'unico handle che sopravvive alla sua morte: quando la shell
     *  esce, i figli che aveva spawnato (server, headless browser) si
     *  riattaccano a init e l'albero si spezza — ma i loro pid restano quelli, e
     *  lo start-time distingue la stessa incarnazione da un pid riciclato.
     *  Serve a spazzarli quando la riga sparisce, invece di lasciarli orfani. */
    tree?: Map<number, string>;
  };
}

// Serializable subset for persistence
interface PersistedScript {
  processId: string;
  scriptName: string;
  command: string;
  projectPath: string;
  status: "running" | "done" | "error";
  pid: number | null;
  /** Vedi `ScriptProcess.pidLstart`. Assente nei file scritti prima del fix. */
  pidLstart?: string;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
}

const MAX_OUTPUT_BYTES = 500 * 1024; // ~500KB per process
const MAX_RECENT = 10;

const runningScripts = new Map<string, ScriptProcess>();
const recentScripts: ScriptProcess[] = [];

// ── Persistence ──────────────────────────────────────────────────────────────

let PERSIST_DIR = "";

function getPersistDir(): string {
  if (!PERSIST_DIR) {
    PERSIST_DIR = join(resolveStateDir(process.cwd()), ".state");
    mkdirSync(PERSIST_DIR, { recursive: true });
  }
  return PERSIST_DIR;
}

function persistPath(): string {
  return join(getPersistDir(), "scripts.json");
}

function saveState() {
  invalidateScriptsCache();
  const data = {
    // Detected processes are ephemeral (re-discovered every detector cycle) and
    // were not spawned by us, so never persist them — only Topics-launched scripts.
    // Le shell in background stanno nella stessa categoria, e in più: un pid
    // scritto su disco e riletto dopo un riavvio può essere stato riciclato dal
    // sistema, e ci si appenderebbe un bottone «Stop».
    running: Array.from(runningScripts.values()).filter(sp => !sp.source || sp.source === "script").map(sp => ({
      processId: sp.processId, scriptName: sp.scriptName, command: sp.command,
      projectPath: sp.projectPath, status: sp.status, pid: sp.pid, pidLstart: sp.pidLstart,
      startedAt: sp.startedAt, completedAt: sp.completedAt, exitCode: sp.exitCode,
    })),
    recent: recentScripts.map(sp => ({
      processId: sp.processId, scriptName: sp.scriptName, command: sp.command,
      projectPath: sp.projectPath, status: sp.status, pid: sp.pid, pidLstart: sp.pidLstart,
      startedAt: sp.startedAt, completedAt: sp.completedAt, exitCode: sp.exitCode,
    })),
  };
  try { writeFileSync(persistPath(), JSON.stringify(data)); } catch {}
}

function loadState() {
  try {
    if (!existsSync(persistPath())) return;
    const data = JSON.parse(readFileSync(persistPath(), "utf-8"));

    // Restore recent scripts (completed ones)
    if (Array.isArray(data.recent)) {
      for (const r of data.recent) {
        const sp: ScriptProcess = {
          ...r,
          output: [],
          outputBytes: 0,
          proc: null,
        };
        // Load output from log file
        const logPath = join(getPersistDir(), "scripts", `${r.processId}.log`);
        try {
          if (existsSync(logPath)) {
            const logContent = readFileSync(logPath, "utf-8");
            sp.output = logContent.split("\n");
              if (sp.output.length && sp.output[sp.output.length - 1] === "") sp.output.pop();
            sp.outputBytes = logContent.length;
          }
        } catch {}
        recentScripts.push(sp);
      }
    }

    // For "running" scripts from a previous server session:
    // Check if the PID is still alive. If yes, re-adopt; if no, mark as error.
    if (Array.isArray(data.running)) {
      for (const r of data.running as PersistedScript[]) {
        if (readoptVerdict({ pid: r.pid, pidLstart: r.pidLstart, probe: pidStartTime }) === "adopt") {
          // Process is still alive — re-track it (we can't re-capture stdout,
          // but we can track its PID for port detection and stop)
          const sp: ScriptProcess = {
            ...r,
            status: "running",
            output: [],
            outputBytes: 0,
            proc: null, // We don't have the handle, but we have the PID
          };
          // Load output from log file
          const logPath = join(getPersistDir(), "scripts", `${r.processId}.log`);
          try {
            if (existsSync(logPath)) {
              const logContent = readFileSync(logPath, "utf-8");
              sp.output = logContent.split("\n");
              if (sp.output.length && sp.output[sp.output.length - 1] === "") sp.output.pop();
              sp.outputBytes = logContent.length;
            } else {
              sp.output = ["[server restarted: previous output lost]"];
              sp.outputBytes = 40;
            }
          } catch {
            sp.output = ["[server restarted: previous output lost]"];
            sp.outputBytes = 40;
          }
          runningScripts.set(r.processId, sp);

          // Poll for exit in background
          pollPidExit(sp);
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
          // Load output from log file
          const deadLogPath = join(getPersistDir(), "scripts", `${r.processId}.log`);
          try {
            if (existsSync(deadLogPath)) {
              const logContent = readFileSync(deadLogPath, "utf-8");
              sp.output = logContent.split("\n");
              if (sp.output.length && sp.output[sp.output.length - 1] === "") sp.output.pop();
              sp.outputBytes = logContent.length;
            }
          } catch {}
          addToRecent(sp);
        }
      }
    }

    // Cleanup old log files for completed processes older than 7 days
    try {
      const scriptsDir = join(getPersistDir(), "scripts");
      if (existsSync(scriptsDir)) {
        const now = Date.now();
        const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
        for (const file of readdirSync(scriptsDir)) {
          if (!file.endsWith('.log')) continue;
          const processId = file.replace('.log', '');
          // Keep logs for running processes
          if (runningScripts.has(processId)) continue;
          // Check if recent and not old
          const recent = recentScripts.find(s => s.processId === processId);
          if (recent?.completedAt && (now - new Date(recent.completedAt).getTime()) < SEVEN_DAYS) continue;
          // Remove old log
          try { unlinkSync(join(scriptsDir, file)); } catch {}
        }
      }
    } catch {}
  } catch {}
}

/**
 * `ps -o lstart=` per un pid, sincrono. `undefined` se il pid non c'e' piu'.
 *
 * Sincrono perche' `loadState()` gira all'import, prima che esista un event
 * loop a cui appendere una promise, ed e' un solo `ps` per script riadottato.
 * `getPidStartTimes` e' il gemello asincrono e in blocco della strada di kill.
 */
function pidStartTime(pid: number): string | undefined {
  try {
    const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)]);
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

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = just check
  } catch {
    return false;
  }
  // signal 0 succeeds for zombies too — check actual state via ps
  try {
    const result = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
    const stat = new TextDecoder().decode(result.stdout).trim();
    if (stat.startsWith("Z")) return false; // zombie
  } catch {}
  return true;
}

let _broadcastCtx: AppContext | null = null;

function pollPidExit(sp: ScriptProcess) {
  const check = () => {
    if (!sp.pid || !isPidAlive(sp.pid)) {
      sp.status = "done";
      sp.completedAt = new Date().toISOString();
      sp.proc = null;
      runningScripts.delete(sp.processId);
      addToRecent(sp);
      saveState();
      if (_broadcastCtx) broadcastScriptsUpdate(_broadcastCtx);
      return;
    }
    setTimeout(check, 3000);
  };
  setTimeout(check, 3000);
}

// ── Port detection per process ───────────────────────────────────────────────

// Cache lsof results for a short time to avoid running it on every request
let cachedPorts: { port: number; pid: number; command: string }[] = [];
let cachedPortsAt = 0;
const PORT_CACHE_TTL = 5000;

export async function getListeningPorts(): Promise<{ port: number; pid: number; command: string }[]> {
  const now = Date.now();
  if (now - cachedPortsAt < PORT_CACHE_TTL) return cachedPorts;

  try {
    const proc = Bun.spawn(["/usr/sbin/lsof", "-iTCP", "-sTCP:LISTEN", "-P", "-n"], { stdout: "pipe", stderr: "ignore" });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const ports: { port: number; pid: number; command: string }[] = [];
    const seen = new Set<number>();
    for (const line of output.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 9) continue;
      const cmd = parts[0];
      const pid = parseInt(parts[1], 10);
      const nameField = parts[8] || "";
      const portMatch = nameField.match(/:(\d+)$/);
      if (!portMatch) continue;
      const port = parseInt(portMatch[1], 10);
      if (seen.has(port)) continue;
      seen.add(port);
      ports.push({ port, pid, command: cmd });
    }
    ports.sort((a, b) => a.port - b.port);
    cachedPorts = ports;
    cachedPortsAt = now;
    return ports;
  } catch {
    return cachedPorts;
  }
}

// Top CPU consumers, system-wide — so the status dropdown can answer "why is my
// PC load high?" with the actual culprits instead of a vague verdict. One cached
// `ps … -r` (sort by CPU) snapshot; refreshed at most every TOP_PROCS_TTL so a
// dropdown polling every few seconds stays cheap.
let cachedTopProcs: { pid: number; cpu: number; command: string }[] = [];
let cachedTopProcsAt = 0;
const TOP_PROCS_TTL = 3000;

export async function getTopCpuProcesses(limit = 6): Promise<{ pid: number; cpu: number; command: string }[]> {
  const now = Date.now();
  if (now - cachedTopProcsAt < TOP_PROCS_TTL && cachedTopProcs.length) return cachedTopProcs.slice(0, limit);
  try {
    // -A all procs, -c accounting (short) command name, -o columns, -r sort by CPU desc.
    const proc = Bun.spawn(["ps", "-Aco", "pid,pcpu,comm", "-r"], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const rows: { pid: number; cpu: number; command: string }[] = [];
    for (const line of text.split("\n").slice(1)) {
      const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+(.+)$/);
      if (!m) continue;
      const cpu = parseFloat(m[2]);
      if (!(cpu > 0)) continue;
      rows.push({ pid: +m[1], cpu: Math.round(cpu), command: m[3].trim() });
      if (rows.length >= 12) break;
    }
    cachedTopProcs = rows;
    cachedTopProcsAt = now;
    return rows.slice(0, limit);
  } catch {
    return cachedTopProcs.slice(0, limit);
  }
}

async function getPortsForProcess(pid: number): Promise<number[]> {
  const allPorts = await getListeningPorts();
  const treePids = await getDescendantPids(pid);
  return allPorts
    .filter(p => treePids.has(p.pid))
    .map(p => p.port);
}

/** Batched port lookup for several tracked pids at once: one lsof + one ps-table
 *  snapshot are shared (both already cached), and the cached port list is walked
 *  ONCE — each listening port is attributed to the first owning tree instead of
 *  re-filtering the whole list per pid (the per-process getPortsForProcess path).
 *  Returns pid → ports[]. */
async function getPortsForProcesses(pids: number[]): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  if (pids.length === 0) return out;
  const allPorts = await getListeningPorts();
  // Descendant closure per tracked pid (shares the cached ps proc table).
  const trees: { pid: number; tree: Set<number> }[] = [];
  for (const pid of pids) {
    out.set(pid, []);
    trees.push({ pid, tree: await getDescendantPids(pid) });
  }
  // Single pass over the cached port list: attribute each port to the first
  // tracked pid whose descendant set owns it.
  for (const lp of allPorts) {
    const owner = trees.find(t => t.tree.has(lp.pid));
    if (owner) out.get(owner.pid)!.push(lp.port);
  }
  return out;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Chiude la riga rimasta in sospeso.
 *
 * Un processo può morire senza aver mai scritto l'ultimo `\n` — un errore
 * stampato e via. Senza questa chiusura quella riga resterebbe nel residuo per
 * sempre: visibile finché il processo è in memoria, persa nel log ricaricato.
 */
function flushPendingLine(sp: ScriptProcess) {
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

function addToRecent(sp: ScriptProcess) {
  flushPendingLine(sp);
  recentScripts.unshift(sp);
  if (recentScripts.length > MAX_RECENT) recentScripts.pop();
}

/**
 * @param whole `true` quando `text` è un blocco COMPLETO e non un frammento di
 *   stream. I chunk di `proc.stdout` arrivano tagliati dove capita, e l'ultima
 *   riga senza `\n` va tenuta in sospeso finché non arriva il resto. Un
 *   `BashOutput` di un agente, invece, è una fotografia intera: trattenerne
 *   l'ultima riga la renderebbe invisibile fino al blocco successivo, che può
 *   non arrivare mai.
 */
function appendOutput(sp: ScriptProcess, text: string, whole = false) {
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
      // Rotation: if > 1MB, keep last 500KB
      if (sp.logBytes > 1024 * 1024) {
        const content = await readFileAsync(logPath);
        await writeFileAsync(logPath, content.subarray(Math.max(0, content.length - 500 * 1024)));
        sp.logBytes = Math.min(content.length, 500 * 1024);
      }
    })
    .catch(() => {});
}

// ── Init ─────────────────────────────────────────────────────────────────────

loadState();
// Runs at MODULE IMPORT (before createAppContext / Bun.serve). getPersistDir()
// now resolves a writable dir, but keep this defensive so a persist-dir failure
// can never abort server boot and hang the "Launching the local engine" splash.
try {
  mkdirSync(join(getPersistDir(), "scripts"), { recursive: true });
} catch (e) {
  console.error("[processes] persist dir init failed (non-fatal):", e);
}

// ── Router ───────────────────────────────────────────────────────────────────

// ── Scripts response cache (2s TTL, invalidated on state change) ─────────
let scriptsResponseCache: { data: any; timestamp: number } | null = null;
const SCRIPTS_CACHE_TTL = 2000;

function invalidateScriptsCache() {
  scriptsResponseCache = null;
}

// Build current scripts list (without port detection for WS broadcasts — ports are fetched on GET)
// Esportata per i test: è la lista che viaggia sulla WS, e deve dire le stesse
// cose della risposta HTTP — se le due divergono la divergenza si vede solo dal vivo.
export function getScriptsSnapshot(): any[] {
  const running = Array.from(runningScripts.values()).map(sp => ({
    processId: sp.processId,
    scriptName: sp.scriptName,
    command: sp.command,
    projectPath: sp.projectPath,
    status: sp.status,
    pid: sp.pid,
    startedAt: sp.startedAt,
    completedAt: sp.completedAt,
    exitCode: sp.exitCode,
    source: sp.source ?? "script",
    // Lo shellId viaggia anche qui, non solo sulla risposta HTTP: le card della
    // chat trovano la loro shell PER id, e il broadcast è ciò che arriva per
    // primo quando la shell nasce o cambia stato. Senza, la card restava
    // ferma fino al prossimo poll — cioè fino a 15s dopo.
    ...(sp.shell ? { shellId: sp.shell.shellId, topicId: sp.shell.topicId } : {}),
    ports: [] as number[],
  }));
  const recent = recentScripts.map(sp => ({
    processId: sp.processId,
    scriptName: sp.scriptName,
    command: sp.command,
    projectPath: sp.projectPath,
    status: sp.status,
    pid: sp.pid,
    startedAt: sp.startedAt,
    completedAt: sp.completedAt,
    exitCode: sp.exitCode,
    source: sp.source ?? "script",
    ...(sp.shell ? { shellId: sp.shell.shellId, topicId: sp.shell.topicId } : {}),
    ports: [] as number[],
  }));
  return [...running, ...recent];
}

// Debounced output notification
let outputNotifyTimer: ReturnType<typeof setTimeout> | null = null;
let pendingOutputIds = new Set<string>();

function notifyScriptOutput(ctx: AppContext, processId: string) {
  pendingOutputIds.add(processId);
  if (!outputNotifyTimer) {
    outputNotifyTimer = setTimeout(() => {
      for (const id of pendingOutputIds) {
        ctx.broadcastToAll({ type: 'scripts:output', processId: id });
      }
      pendingOutputIds.clear();
      outputNotifyTimer = null;
    }, 1000); // max 1 notification per second
  }
}

function broadcastScriptsUpdate(ctx: AppContext) {
  ctx.broadcastToAll({ type: 'scripts:updated', scripts: getScriptsSnapshot() });
}

// ── Review-ready preview servers ─────────────────────────────────────────────
// The preview-manager boots one dev server per task from its worktree at
// review-time. Surface it in the Processes panel (Stop button + port link) so a
// human can see/kill it. Registered as a `script` entry (not `detected`, which
// the detector reconcile would reap) keyed by task, so teardown removes exactly
// one. Ports fill in via the lsof-by-pid path on the HTTP serialize.
// CHIAVE = task + PORTA. Con la sola parte del task, una seconda accensione
// (porta diversa, per esempio dopo che la prima si era prosciugata) SOVRASCRIVEVA
// la riga che teneva il pid vecchio: quel processo restava vivo senza nessuna
// riga, quindi senza bottone Stop e senza nessuno che lo spazzasse, con la sua
// porta occupata per sempre. Il prefisso resta comune cosi' `unregister` puo'
// togliere ogni accensione dello stesso task.
const previewProcessPrefix = (taskId: string) => `preview:${taskId.slice(0, 8)}:`;
const previewProcessKey = (taskId: string, port: number) => `${previewProcessPrefix(taskId)}${port}`;

export function registerPreviewProcess(entry: { taskId: string; port: number; pid: number | null; command: string; cwd: string }): void {
  const processId = previewProcessKey(entry.taskId, entry.port);
  runningScripts.set(processId, {
    processId,
    scriptName: `preview :${entry.port}`,
    command: entry.command,
    projectPath: entry.cwd,
    status: "running",
    pid: entry.pid,
    pidLstart: entry.pid ? pidStartTime(entry.pid) : undefined,
    startedAt: new Date().toISOString(),
    output: [`[anteprima task ${entry.taskId.slice(0, 8)} · http://localhost:${entry.port}]`],
    outputBytes: 0,
    proc: null,
    source: "script",
  });
  saveState();
  if (_broadcastCtx) broadcastScriptsUpdate(_broadcastCtx);
}

/**
 * I pid che il pannello Processi RIVENDICA, coi loro discendenti.
 *
 * A cosa serve: la spazzata delle anteprime cammina le 51 porte del pool e
 * chiude chi ci ascolta se il suo cwd è un worktree conosciuto. Un dev server
 * che un agente ha acceso nel proprio worktree con `run_script` risponde parola
 * per parola a quella descrizione, e senza questo elenco la spazzata non poteva
 * distinguerlo da un residuo: il pannello lo mostra con un bottone Stop, cioè
 * qualcuno lo sta guardando.
 *
 * I DISCENDENTI e non solo il pid registrato: chi ascolta sulla porta è quasi
 * sempre un figlio del lanciatore (`bun run dev` → server), quindi confrontare
 * il solo pid registrato con il listener non avrebbe protetto quasi niente.
 *
 * Le anteprime NON entrano: sono proprio ciò che la spazzata esiste per
 * raccogliere, e proteggerle vorrebbe dire non spazzare mai.
 */
export async function trackedScriptPidTrees(): Promise<Set<number>> {
  const out = new Set<number>();
  for (const [processId, sp] of runningScripts) {
    if (processId.startsWith("preview:")) continue;
    if (sp.status !== "running" || !sp.pid || sp.pid <= 0) continue;
    out.add(sp.pid);
    try { for (const p of await getDescendantPids(sp.pid)) out.add(p); }
    catch { /* la tabella dei processi è best-effort: resta il pid registrato */ }
  }
  return out;
}

export function unregisterPreviewProcess(taskId: string): void {
  // OGNI accensione del task, non solo l'ultima: la chiave porta la porta, e una
  // riga rimasta indietro sarebbe un processo vivo che nessuno ritira.
  const prefix = previewProcessPrefix(taskId);
  let removed = false;
  for (const key of Array.from(runningScripts.keys())) {
    // `preview:<8>` senza porta e' la forma vecchia, ancora possibile in uno
    // stato scritto prima del cambio di chiave: si toglie lo stesso.
    if (key === prefix.slice(0, -1) || key.startsWith(prefix)) {
      runningScripts.delete(key);
      removed = true;
    }
  }
  if (removed) {
    saveState();
    if (_broadcastCtx) broadcastScriptsUpdate(_broadcastCtx);
  }
}

// ── Shell in background lasciate dall'agente (3.5) ────────────────────────────
// `Bash(run_in_background: true)` non è un tool che finisce: è un processo che
// resta. Finora l'unica traccia era la card nel transcript — un ricordo, non uno
// stato: scorreva via, non si contava, e non c'era un posto dove ammazzarla.
// Qui entra nello STESSO registro dei processi, così eredita il pannello che
// esiste già: conteggio nell'intestazione, log, bottone Stop.
//
// L'output arriva dai `BashOutput` che l'agente stesso fa (non lo catturiamo
// noi: il figlio è del CLI). Il pid si cerca nell'albero del CLI della
// sessione; finché non si trova, la voce c'è lo stesso — sapere che una shell
// è viva vale anche senza poterla fermare, e il contrario (un bottone che non
// fa niente) sarebbe peggio del bottone assente.

/** Etichetta corta per la riga del pannello: il comando, senza il romanzo. */
function shellLabel(command: string): string {
  const oneLine = command.replace(/\s+/g, " ").trim();
  return oneLine.length > 48 ? `${oneLine.slice(0, 47)}…` : oneLine || "shell";
}

export function registerBackgroundShell(entry: {
  sessionKey: string;
  topicId: string | null;
  shellId: string;
  command: string;
  cwd: string;
  ownerPid: number | null;
}): void {
  const processId = shellProcessKey(entry.sessionKey, entry.shellId);
  // Ri-registrare la stessa shell non deve azzerarne l'output: l'agente può
  // rilanciare lo stesso id dopo un reattach.
  const existing = runningScripts.get(processId);
  if (existing) {
    if (existing.shell) existing.shell.ownerPid = entry.ownerPid ?? existing.shell.ownerPid;
    return;
  }
  runningScripts.set(processId, {
    processId,
    scriptName: shellLabel(entry.command),
    command: entry.command,
    projectPath: entry.cwd,
    status: "running",
    pid: null,
    startedAt: new Date().toISOString(),
    output: [backgroundShellBanner(entry.shellId)],
    outputBytes: 0,
    proc: null,
    source: "shell",
    shell: {
      shellId: entry.shellId,
      sessionKey: entry.sessionKey,
      topicId: entry.topicId,
      ownerPid: entry.ownerPid,
      resolveAttempts: 0,
    },
  });
  if (_broadcastCtx) broadcastScriptsUpdate(_broadcastCtx);
}

/** Un `BashOutput` dell'agente: output nuovo e, se c'è, stato aggiornato. */
export function noteBackgroundShellOutput(
  sessionKey: string,
  shellId: string,
  patch: { output?: string; status?: "running" | "completed" | "failed" | "killed"; exitCode?: number },
): void {
  const sp = runningScripts.get(shellProcessKey(sessionKey, shellId));
  if (!sp || sp.source !== "shell") return;
  if (patch.output) appendOutput(sp, patch.output, true);
  if (patch.status && patch.status !== "running") {
    finishBackgroundShell(sp, patch.status, patch.exitCode);
    return;
  }
  if (_broadcastCtx) broadcastScriptsUpdate(_broadcastCtx);
}

/** L'agente ha chiamato `KillShell`, o il processo è sparito dalla macchina. */
export function closeBackgroundShell(
  sessionKey: string,
  shellId: string,
  status: "completed" | "failed" | "killed",
  exitCode?: number,
): void {
  const sp = runningScripts.get(shellProcessKey(sessionKey, shellId));
  if (!sp || sp.source !== "shell") return;
  finishBackgroundShell(sp, status, exitCode);
}

/** Vista sola-lettura sulle shell note, vive e appena concluse. */
export function listBackgroundShells(): Array<{
  shellId: string;
  sessionKey: string;
  topicId: string | null;
  command: string;
  status: ScriptProcess["status"];
  pid: number | null;
  exitCode?: number;
  output: string[];
}> {
  const out: ReturnType<typeof listBackgroundShells> = [];
  for (const sp of [...runningScripts.values(), ...recentScripts]) {
    if (sp.source !== "shell" || !sp.shell) continue;
    out.push({
      shellId: sp.shell.shellId,
      sessionKey: sp.shell.sessionKey,
      topicId: sp.shell.topicId,
      command: sp.command,
      status: sp.status,
      pid: sp.pid,
      ...(sp.exitCode != null ? { exitCode: sp.exitCode } : {}),
      output: [...sp.output],
    });
  }
  return out;
}

/** Sposta la shell fra i «recenti» con l'esito giusto. Non persiste nulla: le
 *  shell non sopravvivono al processo che le ha generate. */
function finishBackgroundShell(
  sp: ScriptProcess,
  status: "completed" | "failed" | "killed",
  exitCode?: number,
): void {
  if (sp.status !== "running") return;
  sp.status = status === "completed" ? "done" : "error";
  sp.completedAt = new Date().toISOString();
  if (exitCode != null) sp.exitCode = exitCode;
  else if (status === "killed") sp.exitCode = sp.exitCode ?? -1;
  appendOutput(sp, `\n[shell ${status === "killed" ? "terminata" : status === "failed" ? "fallita" : "conclusa"}]`, true);
  runningScripts.delete(sp.processId);
  addToRecent(sp);
  invalidateScriptsCache();
  if (_broadcastCtx) broadcastScriptsUpdate(_broadcastCtx);
}

/**
 * Trova il processo vero di ogni shell ancora senza pid, e chiude quelle il cui
 * processo non c'è più. Gira nel ciclo del detector, che ha già la tabella dei
 * processi in cache.
 *
 * Il vincolo che rende sicuro il match: il candidato deve essere DISCENDENTE del
 * CLI di quella sessione e la sua riga di comando deve contenere il comando
 * della shell. Solo l'una o solo l'altra condizione non basterebbero — due
 * topic che lanciano `bun run dev` sono indistinguibili senza l'albero, e
 * l'albero da solo contiene anche il CLI e i suoi MCP.
 */
async function reconcileBackgroundShells(): Promise<boolean> {
  const shells = [...runningScripts.values()].filter(sp => sp.source === "shell" && sp.status === "running");
  if (!shells.length) return false;

  let changed = false;
  const claimed = new Set<number>();
  for (const sp of runningScripts.values()) if (sp.pid) claimed.add(sp.pid);

  for (const sp of shells) {
    const meta = sp.shell!;
    // Pid noto: la shell è viva finché il suo processo E il CLI padre lo sono.
    if (sp.pid) {
      const owner = getSessionCliPid(meta.sessionKey) ?? meta.ownerPid;
      const shellDead = !isPidAlive(sp.pid);
      const ownerDead = !owner || !isPidAlive(owner);
      if (shellDead || ownerDead) {
        // Il processo che ci ancorava è morto. La riga sparisce dal pannello —
        // ma i figli che la shell aveva spawnato (server, headless browser) NON
        // muoiono con lei: reparentati a init, fuori da ogni albero, con porte e
        // RAM ancora occupate e nessun bottone Stop a cui siano agganciati.
        // Prima di chiudere la riga li spazziamo, usando l'ultimo sottoalbero
        // catturato mentre la shell era viva.
        await sweepOrphanedShellTree(meta);
        finishBackgroundShell(sp, "completed");
        changed = true;
        continue;
      }
      // Viva: rinfresca lo snapshot del sottoalbero. È l'unico modo per avere i
      // pid dei nipoti ancora a portata quando la shell morirà — a quel punto
      // l'albero è già spezzato e non li ritroveremmo più.
      await captureShellTree(sp.pid, meta);
      continue;
    }
    // L'ancora si rilegge ogni giro invece di fidarsi di quella salvata: lo
    // spawn del CLI è asincrono (il pid può arrivare dopo la registrazione) e
    // alla chiusura della sessione sparisce dal registro. Il pid salvato, da
    // solo, sarebbe un numero che il sistema può aver già riciclato.
    const owner = getSessionCliPid(meta.sessionKey);
    if (owner) meta.ownerPid = owner;
    // Senza CLI padre vivo non c'è albero in cui cercare, né nessuno che ci
    // dica come è finita: la shell è morta con lui. Chiuderla è la lettura
    // onesta — una riga «running» eterna è una bugia che il pannello non
    // potrebbe più correggere. (Il pid non è mai stato risolto, quindi non
    // c'è sottoalbero da spazzare: best effort, no-op.)
    if (!owner || !isPidAlive(owner)) {
      await sweepOrphanedShellTree(meta);
      finishBackgroundShell(sp, "completed");
      changed = true;
      continue;
    }
    if (meta.resolveAttempts >= SHELL_RESOLVE_MAX_ATTEMPTS) continue;
    meta.resolveAttempts++;
    const pid = await resolveShellPid(owner, sp.command, claimed);
    if (pid) { sp.pid = pid; claimed.add(pid); changed = true; }
  }
  return changed;
}

// Dopo N cicli (≈1 minuto) smettiamo di frugare: se il processo non si è fatto
// trovare, o è finito subito o non è ispezionabile. La voce resta viva finché
// il CLI padre è vivo — quello che sappiamo davvero.
const SHELL_RESOLVE_MAX_ATTEMPTS = 15;

/** Il comando come lo cerchiamo in `ps`: una riga, senza spazi ripetuti. */
function normalizeCommandLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

async function resolveShellPid(
  ownerPid: number,
  command: string,
  claimed: Set<number>,
): Promise<number | null> {
  const needle = normalizeCommandLine(command);
  if (needle.length < 3) return null;
  const tree = await getDescendantPids(ownerPid);
  tree.delete(ownerPid); // il CLI stesso non è mai la shell
  const candidates = [...tree].filter(p => !claimed.has(p));
  if (!candidates.length) return null;
  const argv = await getCommandsForPids(candidates);
  for (const [pid, cmd] of argv) {
    if (normalizeCommandLine(cmd).includes(needle)) return pid;
  }
  return null;
}

/** argv di più pid in una sola `ps`. */
async function getCommandsForPids(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!pids.length) return out;
  try {
    const proc = Bun.spawn(["ps", "-o", "pid=,command=", "-p", pids.join(",")], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    for (const line of text.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (m) out.set(+m[1], m[2]);
    }
  } catch { /* ps transitoria: si riprova al ciclo dopo */ }
  return out;
}

/**
 * Rinfresca lo snapshot del sottoalbero di una shell viva: pid → lstart di ogni
 * discendente (la shell stessa esclusa — quella la chiude il CLI). Si spawna una
 * `ps` solo per i pid comparsi dall'ultimo giro: gli start-time già noti si
 * riusano, e i pid spariti si scartano. Girando nel ciclo del detector (con
 * backoff), il costo è una `ps` occasionale per shell viva.
 */
export async function captureShellTree(
  shellPid: number,
  meta: NonNullable<ScriptProcess["shell"]>,
): Promise<void> {
  const tree = await getDescendantPids(shellPid);
  tree.delete(shellPid);
  if (!tree.size) { meta.tree = undefined; return; }
  const prev = meta.tree ?? new Map<number, string>();
  const missing = [...tree].filter(p => !prev.has(p));
  const fresh = missing.length ? await getPidStartTimes(missing) : new Map<number, string>();
  const next = new Map<number, string>();
  for (const p of tree) {
    const start = prev.get(p) ?? fresh.get(p);
    if (start) next.set(p, start);
  }
  meta.tree = next.size ? next : undefined;
}

/**
 * Spazza l'ultimo sottoalbero noto di una shell il cui ancora (shell o CLI) è
 * morto: i figli orfani che il pannello non può più raggiungere. SIGTERM subito,
 * SIGKILL dopo il grace — entrambi SOLO sulla stessa incarnazione: lo start-time
 * corrente deve combaciare con quello dello snapshot, altrimenti quel pid è
 * stato riciclato dal sistema per un processo estraneo e non va toccato.
 * Consuma lo snapshot (uno-shot): niente doppioni se venisse richiamata.
 */
export async function sweepOrphanedShellTree(
  meta: NonNullable<ScriptProcess["shell"]>,
): Promise<void> {
  const snapshot = meta.tree;
  meta.tree = undefined;
  if (!snapshot || !snapshot.size) return;
  const pids = [...snapshot.keys()];
  const now = await getPidStartTimes(pids);
  const live = pids.filter(p => now.get(p) === snapshot.get(p));
  if (!live.length) return;
  for (const p of live) { try { process.kill(p, "SIGTERM"); } catch { /* già morto */ } }
  setTimeout(async () => {
    const still = await getPidStartTimes(live);
    for (const p of live) {
      if (still.get(p) === snapshot.get(p)) {
        try { process.kill(p, "SIGKILL"); } catch { /* uscito nel grace */ }
      }
    }
  }, 5000);
}

// ── Auto-detection of servers started inside Claude PTY sessions ──────────────
// Claude often starts a dev server with a bare shell command (`bun run dev`)
// instead of the run_script MCP tool. That process is a descendant of the
// session's PTY but is never registered, so it's invisible in the Processes
// panel. This detector periodically maps listening ports → owning pid → which
// Claude PTY tree they belong to, and registers each as a tracked
// (source:'detected') ScriptProcess so it shows up live with a working Stop.
// Attribution is by PROCESS TREE (not cwd), so Topics' own servers and unrelated
// machine processes are never mis-claimed.

interface DetectionSession { ptyPid: number; cwd: string; sessionId: string; name: string }
type DetectionSource = () => DetectionSession[];

let _detectionSource: DetectionSource | null = null;
let _detectionTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Cadenza della rilevazione, con BACKOFF.
 *
 * Il ciclo esce subito e gratis quando non c'e' nessuna sessione Claude
 * eleggibile. Ma quando ce n'e' una — cioe' il caso normale di questa app — ogni
 * passata fa `lsof` sulle porte in ascolto, un secondo `lsof` per i cwd dei pid
 * candidati e una tabella dei processi: ~2 spawn ogni 4 secondi, per sempre,
 * anche se nessuno sta guardando il pannello Processi e niente e' cambiato da
 * un'ora. Sono circa 43.000 spawn al giorno per riscoprire lo stesso elenco.
 *
 * Quindi: 4s finche' le cose si MUOVONO, e al raddoppio per ogni passata che non
 * cambia niente, fino a 32s. Qualunque cambiamento — un server che parte, uno
 * che muore — riporta subito a 4s, e cosi' fa `bumpProcessDetection()`, che il
 * percorso HTTP chiama quando un umano apre davvero il pannello. Il tempo di
 * scoperta nel caso peggiore passa da 4s a 32s solo quando per mezzo minuto non
 * e' successo niente, ed e' esattamente il caso in cui a nessuno importa.
 */
export const DETECTION_INTERVAL_MS = 4000;
export const DETECTION_INTERVAL_MAX_MS = 32000;
let _detectionDelayMs = DETECTION_INTERVAL_MS;

/**
 * La prossima attesa, dato lo stato attuale e se la passata ha cambiato
 * qualcosa. Pura, ed esportata per essere verificabile senza timer.
 */
export function nextDetectionDelay(currentMs: number, changed: boolean): number {
  if (changed) return DETECTION_INTERVAL_MS;
  return Math.min(currentMs * 2, DETECTION_INTERVAL_MAX_MS);
}

/** Wire the source of active Claude sessions and start the detection loop.
 *  Called once from server.ts after the terminal + processes routers exist. */
export function startProcessDetection(ctx: AppContext, getSessions: DetectionSource): void {
  _detectionSource = getSessions;
  if (_detectionTimer) return;

  const arm = () => {
    _detectionTimer = setTimeout(tick, _detectionDelayMs);
    // Never let this poller keep the process alive on its own — it's the one
    // long-lived timer that was missing from gracefulShutdown()'s teardown list.
    if (typeof _detectionTimer.unref === "function") _detectionTimer.unref();
  };
  const tick = async () => {
    let changed = false;
    try {
      changed = await runDetectionCycle(ctx);
    } catch (e: any) {
      console.error('[detect] cycle error:', e?.message || e);
    }
    // Un errore NON accelera: se `lsof` fallisce, ritentare ogni 4s non lo fa
    // funzionare, moltiplica solo gli spawn.
    _detectionDelayMs = nextDetectionDelay(_detectionDelayMs, changed);
    arm();
  };

  arm();
  void tick(); // una passata subito, senza aspettare il primo intervallo
}

/**
 * Riporta la rilevazione alla cadenza piena.
 *
 * La chiama il percorso HTTP che serve l'elenco dei processi: se un umano ha
 * aperto il pannello, il backoff non deve fargli aspettare mezzo minuto la
 * comparsa di un server appena avviato.
 */
export function bumpProcessDetection(): void {
  _detectionDelayMs = DETECTION_INTERVAL_MS;
}

function detectedKey(pid: number): string { return `detected:${pid}`; }

// Never register these as a "server" even if they hold a port: the claude
// binary/daemon itself and the stdio Topics MCP bridge (defensive).
function isNoiseCommand(cmd: string): boolean {
  const c = cmd.toLowerCase();
  return c.includes("claude") || c.includes("topics-mcp");
}

/** Full argv of a pid (`ps -o command=`), for a readable label. Falls back to "". */
async function getCommandForPid(pid: number): Promise<string> {
  try {
    const proc = Bun.spawn(["ps", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return out.split("\n")[0] || "";
  } catch { return ""; }
}

// The port Topics itself listens on — never report it as a detected server.
const OWN_PORT = Number(process.env.BUN_PORT) || 3333;
// Sessions whose cwd is under one of these roots are tooling/infra, not user
// projects, so we don't surface the long-running services living there (the
// Claude config tree holds the user's router / vector DB / memory daemons). A
// session in a real project dir (Projects/, Sites/, …) is detected normally.
const INFRA_CWD_PREFIXES = [`${process.env.HOME || ""}/.claude`].filter(p => p.length > 1);
function isInfraCwd(cwd: string): boolean {
  return INFRA_CWD_PREFIXES.some(p => cwd === p || cwd.startsWith(p + "/"));
}
// A session cwd that is HOME (or an ancestor of it, or `/`) is too broad: cwd
// attribution would then claim EVERY listening process under home (infra,
// Electron, unrelated servers). Only sessions cwd'd into a specific project dir
// get cwd-based detection. (Tree-based detection still applies to them.)
const _HOME = process.env.HOME || "";
function isBroadCwd(cwd: string): boolean {
  if (!cwd || cwd === "/" || cwd === _HOME) return true;
  return _HOME.length > 1 && (_HOME === cwd || _HOME.startsWith(cwd + "/"));
}

/** cwd of each pid via one batched lsof. Pids without a cwd are omitted. */
async function getProcessCwds(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (pids.length === 0) return out;
  try {
    const proc = Bun.spawn(["/usr/sbin/lsof", "-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    let cur = 0;
    for (const line of text.split("\n")) {
      if (line[0] === "p") cur = parseInt(line.slice(1), 10);
      else if (line[0] === "n" && cur) out.set(cur, line.slice(1));
    }
  } catch {}
  return out;
}

function isWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : parent + "/");
}

async function runDetectionCycle(ctx: AppContext): Promise<boolean> {
  // Le shell in background si riconciliano SEMPRE, anche quando non c'è
  // nessuna sessione Claude idonea al detector delle porte: una shell non deve
  // per forza ascoltare su una porta per essere viva (è l'intero motivo per cui
  // il pannello finora non la vedeva).
  if (await reconcileBackgroundShells()) broadcastScriptsUpdate(ctx);

  if (!_detectionSource) return false;
  // Active Claude sessions in REAL project dirs (skip the infra/config tree).
  const sessions = _detectionSource().filter(s => s.ptyPid > 0 && !isInfraCwd(s.cwd));

  // No eligible Claude sessions → reap any leftover detected entries and stop.
  if (sessions.length === 0) {
    let changed = false;
    for (const sp of [...runningScripts.values()]) {
      if (sp.source === "detected") { runningScripts.delete(sp.processId); changed = true; }
    }
    if (changed) broadcastScriptsUpdate(ctx);
    return changed;
  }

  const allPorts = await getListeningPorts();

  // Ports already owned by a Topics-launched (script) process — don't double-list.
  const managedPorts = new Set<number>();
  for (const sp of runningScripts.values()) {
    if (sp.source === "detected" || !sp.pid) continue;
    for (const p of await getPortsForProcess(sp.pid)) managedPorts.add(p);
  }

  // Candidate listening ports: not Topics' own, not already a tracked script,
  // not the claude binary / MCP bridge itself.
  const candidates = allPorts.filter(lp =>
    lp.port !== OWN_PORT && !managedPorts.has(lp.port) && !isNoiseCommand(lp.command));

  // Attribute each candidate to a session by, in order:
  //  (1) cwd — it runs inside the session's project dir. PRIMARY signal: a dev
  //      server Claude backgrounds reparents to launchd (ppid 1), so a
  //      process-tree walk from the PTY misses it, but its cwd stays in the dir.
  //  (2) tree — it's a live descendant of the session's PTY (catches a server
  //      whose cwd is elsewhere, e.g. started in /tmp).
  const pidSet = [...new Set(candidates.map(c => c.pid))];
  const cwds = await getProcessCwds(pidSet);
  const trees = new Map<string, Set<number>>();
  for (const s of sessions) trees.set(s.sessionId, await getDescendantPids(s.ptyPid));
  // cwd-attribution candidates: specific project dirs only (a session cwd'd at
  // HOME would otherwise claim everything under it). Longest (most specific) wins
  // when nested. Broad-cwd sessions still get TREE attribution below.
  const byDepth = sessions.filter(s => !isBroadCwd(s.cwd)).sort((a, b) => b.cwd.length - a.cwd.length);

  const desired = new Map<string, { pid: number; cwd: string; lsofCmd: string; ports: number[] }>();
  for (const lp of candidates) {
    const pcwd = cwds.get(lp.pid);
    const owner = (pcwd ? byDepth.find(s => isWithin(pcwd, s.cwd)) : undefined)
      || sessions.find(s => trees.get(s.sessionId)?.has(lp.pid));
    if (!owner) continue;
    if (lp.pid === owner.ptyPid) continue; // the claude process itself
    const key = detectedKey(lp.pid);
    const entry = desired.get(key);
    if (entry) { if (!entry.ports.includes(lp.port)) entry.ports.push(lp.port); }
    else desired.set(key, { pid: lp.pid, cwd: owner.cwd, lsofCmd: lp.command, ports: [lp.port] });
  }

  let changed = false;

  // Reap detected entries whose server no longer holds a port (it stopped).
  for (const sp of [...runningScripts.values()]) {
    if (sp.source !== "detected") continue;
    if (!desired.has(sp.processId)) { runningScripts.delete(sp.processId); changed = true; }
  }

  // Register newly-seen detected servers (existing ones keep their entry; ports
  // refresh via the HTTP serialize path).
  for (const [key, d] of desired) {
    if (runningScripts.has(key)) continue;
    const full = await getCommandForPid(d.pid);
    runningScripts.set(key, {
      processId: key,
      scriptName: d.lsofCmd || "server",                 // short label (e.g. "node", "bun")
      command: full || d.lsofCmd,                        // full argv when available
      projectPath: d.cwd,
      status: "running",
      pid: d.pid,
      startedAt: new Date().toISOString(),
      output: ["[auto-detected running server. Topics did not launch it, so its logs are not captured here]"],
      outputBytes: 0,
      proc: null,
      source: "detected",
    });
    changed = true;
  }

  if (changed) broadcastScriptsUpdate(ctx);
  return changed;
}

export function createProcessesRouter(ctx: AppContext): RouteHandler {
  const { json } = ctx;
  _broadcastCtx = ctx; // store for pollPidExit callbacks

  async function readJSON(req: Request): Promise<any> {
    try { return await req.json(); } catch { return null; }
  }

  /**
   * Spawn `npm run <scriptName>` in projectPath, register it in the running
   * map, wire stdout/stderr streaming + exit handling, and return the public
   * payload. Shared by the UI endpoint (POST /api/scripts/run) and the
   * session-keyed MCP endpoint (POST /api/sessions/:sessionKey/scripts/run).
   */
  function startScriptProcess(
    projectPath: string,
    scriptName: string,
    useTty: boolean,
  ): { processId: string; scriptName: string; pid: number | null; startedAt: string } {
    const processId = crypto.randomUUID();
    // Il comando viene dallo script RILEVATO, non da `npm run` cablato: un
    // target di Makefile si lancia con `make`, un task di deno con `deno task`,
    // e uno script di un progetto Bun con `bun run` e non con npm. Chi chiama
    // passa l'id (`<manifest>#<nome>`), oppure il solo nome per i chiamanti
    // vecchi — `resolveScript` accetta tutt'e due.
    const rilevato = resolveScript(detectScripts(projectPath), scriptName);
    if (!rilevato) throw new Error(`Script "${scriptName}" non trovato in questo progetto`);
    const command = rilevato.argv.join(" ");
    const base = rilevato.argv;
    const argv = useTty ? wrapPty(base) : base;

    const proc = Bun.spawn(argv, {
      cwd: projectPath,
      stdout: "pipe",
      stderr: "pipe",
      env: augmentEnv(process.env, {
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        HOST: "0.0.0.0",
        NODE_ENV: "development",
        npm_config_yes: "true",
      }),
    });

    const sp: ScriptProcess = {
      processId,
      // Il NOME, non l'id: e quello che si legge nella lista e nei log.
      scriptName: rilevato.name,
      command,
      projectPath,
      status: "running",
      pid: proc.pid,
      // Timbrato allo spawn, finche' il processo e' certamente nostro: dopo un
      // riavvio del server questo e' l'unico modo di sapere che il pid sul
      // disco e' ancora la stessa incarnazione. Vedi `readoptVerdict`.
      pidLstart: pidStartTime(proc.pid),
      startedAt: new Date().toISOString(),
      output: [],
      outputBytes: 0,
      proc,
    };

    runningScripts.set(processId, sp);
    saveState();
    broadcastScriptsUpdate(ctx);

    if (proc.stdout) {
      (async () => {
        const reader = proc.stdout!.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            appendOutput(sp, useTty ? stripAnsi(chunk) : chunk);
            notifyScriptOutput(ctx, processId);
          }
        } catch {}
      })();
    }

    if (proc.stderr) {
      (async () => {
        const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            appendOutput(sp, useTty ? stripAnsi(chunk) : chunk);
            notifyScriptOutput(ctx, processId);
          }
        } catch {}
      })();
    }

    proc.exited.then((exitCode) => {
      sp.status = exitCode === 0 ? "done" : "error";
      sp.exitCode = exitCode;
      sp.completedAt = new Date().toISOString();
      sp.proc = null;
      runningScripts.delete(processId);
      addToRecent(sp);
      saveState();
      broadcastScriptsUpdate(ctx);
    });

    return { processId, scriptName: rilevato.name, pid: proc.pid, startedAt: sp.startedAt };
  }

  // ── Session scoping helpers (shared by MCP-bridge session endpoints) ──────

  /** Resolve a sessionKey to its topic's working directory, or an error Response. */
  function resolveSessionCwd(sessionKey: string): { path: string } | { error: Response } {
    const topic = ctx.getTopicBySessionKey(sessionKey);
    if (topic) {
      const path = ctx.resolveTopicCwd(topic);
      if (!path) return { error: json({ error: "This topic has no project directory. Bind it to a project first." }, 400) };
      return { path };
    }
    // Terminal-driven: a Claude Code *terminal* tab spawns its MCP bridge with the
    // terminal session id as the sessionKey (see writeMcpConfigForSession), which
    // matches no chat topic. Mirror the open-pane fallback (topics.ts) and resolve
    // the terminal's own working directory, so list_processes / run_script /
    // read_process_output / stop_process work from a terminal too instead of 404ing
    // "No topic bound to this session".
    const term = getTerminalSessionById(sessionKey);
    if (term?.cwd) return { path: term.cwd };
    return { error: json({ error: "No topic bound to this session" }, 404) };
  }

  const getScript = (id: string): ScriptProcess | undefined =>
    runningScripts.get(id) || recentScripts.find(r => r.processId === id);

  /** Build the `{ scripts }` payload, optionally filtered to one project path. */
  async function serializeScripts(filterCwd?: string): Promise<{ scripts: any[] }> {
    const match = (sp: ScriptProcess) => !filterCwd || sp.projectPath === filterCwd;
    const running = Array.from(runningScripts.values()).filter(match);
    // One batched port lookup for all running pids (shared lsof + ps snapshot,
    // single pass over the cached port list) instead of per-process.
    const portsByPid = await getPortsForProcesses(
      running.map(sp => sp.pid).filter((p): p is number => !!p),
    );
    const runningList = running.map(sp => ({
      processId: sp.processId, scriptName: sp.scriptName, command: sp.command,
      projectPath: sp.projectPath, status: sp.status, pid: sp.pid,
      startedAt: sp.startedAt, completedAt: sp.completedAt, exitCode: sp.exitCode,
      source: sp.source ?? "script",
      ...(sp.shell ? { shellId: sp.shell.shellId, topicId: sp.shell.topicId } : {}),
      ports: sp.pid ? (portsByPid.get(sp.pid) ?? []) : [],
    }));
    const recentList = recentScripts.filter(match).map(sp => ({
      processId: sp.processId, scriptName: sp.scriptName, command: sp.command,
      projectPath: sp.projectPath, status: sp.status, pid: sp.pid,
      startedAt: sp.startedAt, completedAt: sp.completedAt, exitCode: sp.exitCode,
      source: sp.source ?? "script",
      ...(sp.shell ? { shellId: sp.shell.shellId, topicId: sp.shell.topicId } : {}),
      ports: [] as number[],
    }));
    return { scripts: [...runningList, ...recentList] };
  }

  /**
   * Il pezzo di log che il client non ha ancora, con un cursore ASSOLUTO.
   *
   * `offset` conta le righe dall'inizio del processo, non le posizioni
   * nell'array: `droppedLines` fa da origine. Prima era un indice dentro
   * `sp.output`, che il ring buffer accorcia da sotto — quindi dopo
   * un'eviction lo stesso numero indicava un'altra riga, e il client perdeva
   * righe in silenzio (o si rivedeva blocchi già visti).
   *
   * `truncatedLines` dice quante ne ha perse davvero, invece di lasciargli
   * credere di aver visto tutto.
   */
  const outputPayload = (sp: ScriptProcess, offset: number) => {
    const slice = sliceFromCursor({
      output: sp.output,
      outputBytes: sp.outputBytes,
      droppedLines: sp.droppedLines ?? 0,
      pendingLine: sp.pendingLine ?? "",
    }, offset);
    return { ...slice, done: sp.status !== "running", status: sp.status, exitCode: sp.exitCode };
  };

  /**
   * Terminate a running script (process-group kill + delayed SIGKILL) and clean up.
   * Torna `false` quando non c'è niente da ammazzare: una shell il cui processo
   * non è ancora stato individuato nell'albero del CLI. Togliere la riga in quel
   * caso sarebbe la bugia peggiore — il processo resterebbe vivo, ma invisibile.
   */
  function killRunningScript(sp: ScriptProcess): boolean {
    if (sp.source === "detected" || sp.source === "shell") {
      // We didn't spawn it (no `proc`, no exit handler). Kill the pid + its
      // descendant tree directly — NOT a process-group kill, to avoid any chance
      // of signalling the Claude PTY's group. Remove it immediately so Stop feels
      // instant; the detector confirms on its next cycle.
      const dpid = sp.pid;
      const shellMeta = sp.source === "shell" ? sp.shell : undefined;
      if (sp.source === "shell") {
        if (!dpid) return false;
        // Una shell finisce fra i «recenti» con l'esito giusto invece di sparire:
        // il pannello è anche il posto dove si legge cosa aveva stampato.
        // NB: finishBackgroundShell azzererebbe sp.shell più avanti? No — ma lo
        // snapshot va letto DOPO, quindi lo teniamo in shellMeta qui sopra.
        finishBackgroundShell(sp, "killed");
        // Fallback: se la shell è già morta, l'albero live sotto è spezzato e i
        // nipoti reparentati sfuggirebbero al kill del sottoalbero qui sotto.
        // Lo snapshot catturato mentre era viva li ritrova comunque.
        if (shellMeta) void sweepOrphanedShellTree(shellMeta);
      }
      else runningScripts.delete(sp.processId);
      if (dpid && isPidAlive(dpid)) {
        getDescendantPids(dpid).then(async tree => {
          const pids = [...tree];
          // Capture each pid's identity BEFORE signalling: the delayed SIGKILL
          // must only fire on the same incarnation (see getPidStartTimes).
          const identity = await getPidStartTimes(pids);
          for (const p of pids) { try { process.kill(p, "SIGTERM"); } catch {} }
          setTimeout(async () => {
            const still = await getPidStartTimes(pids);
            for (const p of pids) {
              const then = identity.get(p);
              if (then && still.get(p) === then) {
                try { process.kill(p, "SIGKILL"); } catch {}
              }
            }
          }, 5000);
        }).catch(() => { try { process.kill(dpid, "SIGTERM"); } catch {} });
      }
      broadcastScriptsUpdate(ctx);
      return true;
    }
    const pid = sp.pid;
    if (!pid || !isPidAlive(pid)) {
      sp.status = "error";
      sp.completedAt = new Date().toISOString();
      sp.exitCode = sp.exitCode ?? -1;
      sp.proc = null;
      runningScripts.delete(sp.processId);
      addToRecent(sp);
      saveState();
      broadcastScriptsUpdate(ctx);
      return true;
    }
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    setTimeout(() => {
      // Identity guard: if OUR process already exited (proc.exited handler set
      // status + removed it from runningScripts within the grace), the pid may
      // have been recycled by the OS — SIGKILLing it now could hit an unrelated
      // fresh process. Our own bookkeeping is the authoritative liveness check.
      if (sp.status !== "running") return;
      try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch {}
    }, 5000);
    return true;
  }

  return async function processesRouter(req: Request, url: URL, pathname: string, method: string): Promise<Response | null> {

    // POST /api/scripts/run — start a script (UI endpoint, ungated)
    if (method === "POST" && pathname === "/api/scripts/run") {
      const body = await readJSON(req);
      if (!body?.projectPath || !body?.scriptName) {
        return json({ error: "projectPath and scriptName required" }, 400);
      }
      // tty: true (default) wraps the command in script(1) so it gets a PTY.
      // Required by CLIs that check isatty() — supabase login, gh auth login,
      // npm login, etc. Set body.tty=false explicitly for legacy behavior.
      const useTty = body.tty !== false;
      try {
        return json(startScriptProcess(body.projectPath as string, body.scriptName as string, useTty));
      } catch (err: any) {
        return json({ error: `Failed to spawn: ${err.message}` }, 500);
      }
    }

    // POST /api/sessions/:sessionKey/scripts/run — session-keyed run (MCP bridge)
    //
    // The MCP surface for non-SDK providers: the bridge subprocess only knows
    // its sessionKey, so we resolve the topic → working directory here instead
    // of trusting a caller-supplied path. Because the spawning agent runs under
    // `--permission-mode bypassPermissions`, we gate scriptName against the
    // project's package.json — a declared script may run, an arbitrary one is
    // rejected with the list of what's available (which doubles as discovery).
    {
      const m = method === "POST" && pathname.match(/^\/api\/sessions\/([^/]+)\/scripts\/run$/);
      if (m) {
        const sessionKey = decodeURIComponent(m[1]);
        const body = await readJSON(req);
        const scriptName = body?.scriptName;
        if (typeof scriptName !== "string" || !scriptName) {
          return json({ error: "scriptName (string) is required" }, 400);
        }

        const r = resolveSessionCwd(sessionKey);
        if ("error" in r) return r.error;
        const projectPath = r.path;

        // Il cancello guarda lo STESSO insieme che l'esecutore sa lanciare.
        // Finche leggeva solo `package.json`, allargare il rilevamento avrebbe
        // voluto dire o un agente che non puo lanciare quello che vede, o —
        // peggio — due idee diverse di «script consentito» nello stesso server.
        const rilevati = detectScripts(projectPath);
        if (rilevati.found.length === 0) {
          return json({ error: `Nessun manifest di script in ${projectPath} (guardati: ${MANIFESTS.join(", ")})` }, 400);
        }
        if (!resolveScript(rilevati, scriptName)) {
          return json({
            error: `Lo script "${scriptName}" non e dichiarato in questo progetto`,
            available: rilevati.scripts.map(x => x.id),
          }, 400);
        }

        const useTty = body?.tty !== false;
        try {
          return json(startScriptProcess(projectPath, scriptName, useTty));
        } catch (err: any) {
          return json({ error: `Failed to spawn: ${err.message}` }, 500);
        }
      }
    }

    // GET /api/scripts — list running + recent, with per-process ports
    if (method === "GET" && pathname === "/api/scripts") {
      // Qualcuno sta guardando: la rilevazione torna alla cadenza piena, cosi'
      // il backoff non fa aspettare mezzo minuto la comparsa di un server
      // appena avviato. Sta PRIMA della cache: la richiesta e' il segnale di
      // interesse, indipendentemente da chi risponde.
      bumpProcessDetection();
      // Server-side cache check (2s TTL)
      if (scriptsResponseCache && Date.now() - scriptsResponseCache.timestamp < SCRIPTS_CACHE_TTL) {
        return json(scriptsResponseCache.data);
      }
      const scriptsResult = await serializeScripts();
      scriptsResponseCache = { data: scriptsResult, timestamp: Date.now() };
      return json(scriptsResult);
    }

    // GET /api/scripts/:id/output — get process output (streaming with offset)
    const outputMatch = method === "GET" && pathname.match(/^\/api\/scripts\/([^/]+)\/output$/);
    if (outputMatch) {
      const sp = getScript(outputMatch[1]);
      if (!sp) return json({ error: "Process not found" }, 404);
      const offset = parseInt(url.searchParams.get("offset") || "0", 10);
      return json(outputPayload(sp, offset));
    }

    // POST /api/scripts/:id/stop — kill a running process
    const stopMatch = method === "POST" && pathname.match(/^\/api\/scripts\/([^/]+)\/stop$/);
    if (stopMatch) {
      const sp = runningScripts.get(stopMatch[1]);
      if (!sp) return json({ error: "Process not found or already stopped" }, 404);
      if (!killRunningScript(sp)) {
        // Shell dell'agente di cui non abbiamo ancora trovato il processo: il
        // «no» esplicito è meglio di un ok che non ferma niente.
        return json({ error: "shell_pid_unknown", message: "Processo non ancora individuato: fermala dalla chat con KillShell." }, 409);
      }
      return json({ ok: true });
    }

    // ── Session-scoped reads/controls (MCP bridge) ───────────────────────────
    // These resolve sessionKey → topic → working directory and only expose
    // processes that belong to that project, so an agent in topic A can never
    // see or kill processes started under topic B.

    // GET /api/sessions/:sessionKey/scripts
    {
      const m = method === "GET" && pathname.match(/^\/api\/sessions\/([^/]+)\/scripts$/);
      if (m) {
        const r = resolveSessionCwd(decodeURIComponent(m[1]));
        if ("error" in r) return r.error;
        return json(await serializeScripts(r.path));
      }
    }

    // GET /api/sessions/:sessionKey/scripts/:id/output
    {
      const m = method === "GET" && pathname.match(/^\/api\/sessions\/([^/]+)\/scripts\/([^/]+)\/output$/);
      if (m) {
        const r = resolveSessionCwd(decodeURIComponent(m[1]));
        if ("error" in r) return r.error;
        const sp = getScript(m[2]);
        if (!sp || sp.projectPath !== r.path) {
          return json({ error: "Process not found in this project" }, 404);
        }
        const offset = parseInt(url.searchParams.get("offset") || "0", 10);
        return json(outputPayload(sp, offset));
      }
    }

    // POST /api/sessions/:sessionKey/scripts/:id/stop
    {
      const m = method === "POST" && pathname.match(/^\/api\/sessions\/([^/]+)\/scripts\/([^/]+)\/stop$/);
      if (m) {
        const r = resolveSessionCwd(decodeURIComponent(m[1]));
        if ("error" in r) return r.error;
        const sp = runningScripts.get(m[2]);
        if (!sp || sp.projectPath !== r.path) {
          return json({ error: "Process not found in this project or already stopped" }, 404);
        }
        if (!killRunningScript(sp)) {
          return json({ error: "shell_pid_unknown", message: "Processo non ancora individuato: usa KillShell sull'id della shell." }, 409);
        }
        return json({ ok: true });
      }
    }

    return null;
  };
}
