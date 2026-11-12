import { existsSync, realpathSync } from "fs";
import { homedir } from "os";
import { join, relative, sep } from "path";
import { isInsideDir } from "../lib/path-containment";
import { isTopicsSpawned } from "../lib/ghost-script";
import type { AppContext } from "../types";
import { killProcessTree } from "../lib/process-tree";
import { getDescendantPids } from "../lib/process-tree";
import { isBroadCwd } from "../lib/broad-cwd";
import { getListeningPorts } from "../lib/listening-ports";
import { recordServerSpawn } from "../lib/spawn-metrics";
import { SPAWN_TIMEOUT, spawnBounded } from "../lib/bounded-spawn";
import { loadProcessRegistry, saveState } from "./processes-persist";
import { reconcileBackgroundShells } from "./processes-shells";
import { broadcastScriptsUpdate, getPortsForProcess } from "./processes-snapshot";
import { runningScripts } from "./processes-state";

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
let _detectionStarted = false;
let _detectionRunning = false;
let _detectionInterestedUntil = 0;
let _wakeProcessDetection: (() => void) | null = null;
/** Which loop is the live one: a cycle in flight when the loop was stopped does not re-arm it. */
let _detectionLoop = 0;

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
export const GHOST_CWD_PROBE_MIN_INTERVAL_MS = 120_000;
let lastGhostCwdProbeAt = 0;

export function processDetectionViewIsOpen(now = Date.now()): boolean {
  return now < _detectionInterestedUntil;
}

export function ghostCwdProbeDue(now: number, previousAt: number): boolean {
  return now - previousAt >= GHOST_CWD_PROBE_MIN_INTERVAL_MS;
}

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
  loadProcessRegistry();
  _detectionSource = getSessions;
  // Set before the first async cycle: a second start while it is running must
  // not create a second loop just because the first timer is not armed yet.
  if (_detectionStarted) return;
  _detectionStarted = true;

  const loop = ++_detectionLoop;
  const arm = () => {
    if (loop !== _detectionLoop) return; // stopped while a cycle was in flight
    _detectionTimer = setTimeout(tick, _detectionDelayMs);
    // Never let this poller keep the process alive on its own — it's the one
    // long-lived timer that was missing from gracefulShutdown()'s teardown list.
    if (typeof _detectionTimer.unref === "function") _detectionTimer.unref();
  };
  const tick = async () => {
    if (_detectionRunning) return;
    _detectionRunning = true;
    let changed = false;
    try {
      changed = await runDetectionCycle(ctx);
    } catch (e: any) {
      console.error('[detect] cycle error:', e?.message || e);
    } finally {
      _detectionRunning = false;
    }
    // Un errore NON accelera: se `lsof` fallisce, ritentare ogni 4s non lo fa
    // funzionare, moltiplica solo gli spawn.
    _detectionDelayMs = nextDetectionDelay(_detectionDelayMs, changed);
    arm();
  };
  _wakeProcessDetection = () => {
    if (_detectionTimer) clearTimeout(_detectionTimer);
    _detectionTimer = null;
    void tick();
  };

  // The completed cycle alone arms its successor. Arming here as well creates
  // two permanent timer chains (4s and 8s already pending on an idle startup).
  void tick(); // una passata subito, senza aspettare il primo intervallo
}

/**
 * Stop the loop `startProcessDetection` armed, for the test that started it.
 * The loop is module state and every test file of a run shares the process:
 * left running, it closed as `killed` the background shells a LATER file
 * registered without a live CLI, in the middle of that file's assertions.
 */
export function stopProcessDetectionForTests(): void {
  _detectionLoop++;
  if (_detectionTimer) clearTimeout(_detectionTimer);
  _detectionTimer = null;
  _detectionStarted = false;
  _detectionRunning = false;
  _detectionInterestedUntil = 0;
  lastGhostCwdProbeAt = 0;
  _wakeProcessDetection = null;
  _detectionDelayMs = DETECTION_INTERVAL_MS;
}

/**
 * Riporta la rilevazione alla cadenza piena.
 *
 * La chiama il percorso HTTP che serve l'elenco dei processi: se un umano ha
 * aperto il pannello, il backoff non deve fargli aspettare mezzo minuto la
 * comparsa di un server appena avviato.
 */
export function bumpProcessDetection(): void {
  _detectionInterestedUntil = Date.now() + 15_000;
  _detectionDelayMs = DETECTION_INTERVAL_MS;
  _wakeProcessDetection?.();
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
    const proc = spawnBounded(["ps", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore", timeoutMs: SPAWN_TIMEOUT.query });
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
// Built with `join`, not by gluing `HOME` to a slash: on Windows the variable
// is `USERPROFILE` and the separator is a backslash, so the glued string named
// no directory at all and every infra session was surfaced as a dev server.
const INFRA_CWD_PREFIXES = [join(homedir(), ".claude")].filter(p => p.length > 1);
function isInfraCwd(cwd: string): boolean {
  return INFRA_CWD_PREFIXES.some(p => isInsideDir(cwd, p));
}
// A session cwd that is HOME (or an ancestor of it, or `/`) is too broad: cwd
// attribution would then claim EVERY listening process under home (infra,
// Electron, unrelated servers). Only sessions cwd'd into a specific project dir
// get cwd-based detection. (Tree-based detection still applies to them.)
// The predicate lives in `server/lib/broad-cwd.ts` because the file-route
// allowlist (`services/known-project-dirs.ts`) needs the very same rule.

/** cwd of each pid via one batched lsof. Pids without a cwd are omitted. */
async function getProcessCwds(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (pids.length === 0) return out;
  try {
    recordServerSpawn("lsof", "detectionCwd");
    const proc = spawnBounded(["/usr/sbin/lsof", "-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")], { stdout: "pipe", stderr: "ignore", timeoutMs: SPAWN_TIMEOUT.query });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    let cur = 0;
    for (const line of text.split("\n")) {
      if (line[0] === "p") cur = parseInt(line.slice(1), 10);
      else if (line[0] === "n" && cur) out.set(cur, line.slice(1));
    }
  } catch { /* lsof failure or timeout: callers treat a missing cwd as unknown */ }
  return out;
}

function isWithin(child: string, parent: string): boolean {
  return isInsideDir(child, parent);
}

async function runDetectionCycle(ctx: AppContext): Promise<boolean> {
  // Le shell in background si riconciliano SEMPRE, anche quando non c'è
  // nessuna sessione Claude idonea al detector delle porte: una shell non deve
  // per forza ascoltare su una porta per essere viva (è l'intero motivo per cui
  // il pannello finora non la vedeva).
  let changed = await reconcileBackgroundShells();
  if (changed) broadcastScriptsUpdate(ctx);

  if (!_detectionSource) return changed;
  // Active Claude sessions in REAL project dirs (skip the infra/config tree).
  const sessions = _detectionSource().filter(s => s.ptyPid > 0 && !isInfraCwd(s.cwd));

  // No eligible Claude sessions → reap any leftover detected entries and stop.
  if (sessions.length === 0) {
    let detectedChanged = false;
    for (const sp of [...runningScripts.values()]) {
      if (sp.source === "detected") { runningScripts.delete(sp.processId); detectedChanged = true; }
    }
    if (detectedChanged) broadcastScriptsUpdate(ctx);
    return changed || detectedChanged;
  }
  const ghostChanged = await reapGhostScripts(ctx);
  if (!processDetectionViewIsOpen()) return changed || ghostChanged;

  const allPorts = await getListeningPorts(undefined, "detectionPorts");

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

  let detectedChanged = false;

  // Reap detected entries whose server no longer holds a port (it stopped).
  for (const sp of [...runningScripts.values()]) {
    if (sp.source !== "detected") continue;
    if (!desired.has(sp.processId)) { runningScripts.delete(sp.processId); detectedChanged = true; }
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
    detectedChanged = true;
  }

  changed = changed || detectedChanged || ghostChanged;

  if (changed) broadcastScriptsUpdate(ctx);
  return changed;
}

/**
 * PUNTO 2 (task e3240a22): sweep di recupero per i fantasmi gia' nati.
 *
 * Criterio: source:"script", cwd registrato sotto ~/.topics/worktrees/,
 * e la root della worktree (project/name) non esiste piu' su disco.
 *
 * L'identita' (pid+lstart) e' gia' catturata al momento della registrazione
 * (campo pidLstart) e riverificata da killProcessTree prima di ogni segnale.
 *
 * Se TOPICS_GHOST_REAP != "1": solo log.
 * Se TOPICS_GHOST_REAP === "1": uccide.
 */
async function reapGhostScripts(ctx: AppContext): Promise<boolean> {
  const GHOST_REAP_ARMED = process.env.TOPICS_GHOST_REAP === "1";
  const wtBase = ctx.worktreeManager.worktreesDir();

  // Candidati: script registrati con projectPath sotto la base dei worktree
  const candidates = [...runningScripts.values()].filter(sp => {
    if (!isTopicsSpawned(sp.source) || sp.status !== "running" || !sp.pid) return false;
    return isInsideDir(sp.projectPath, wtBase);
  });
  if (candidates.length === 0) return false;
  const now = Date.now();
  if (!ghostCwdProbeDue(now, lastGhostCwdProbeAt)) return false;
  lastGhostCwdProbeAt = now;

  // Per ogni candidato: verifica il cwd reale via lsof (un solo batch)
  const pids = candidates.map(s => s.pid as number);
  const cwdMap = await getProcessCwds(pids).catch(() => new Map<number, string>());

  let changed = false;
  for (const sp of candidates) {
    // cwd reale: preferisce lsof; cade sul projectPath registrato
    const rawCwd = cwdMap.get(sp.pid as number) ?? sp.projectPath;
    // Risolvi symlink (es. /tmp vs /private/tmp su macOS)
    let cwdReal = rawCwd;
    try { cwdReal = realpathSync(rawCwd); } catch { /* cartella sparita: il path e' gia' il vero */ }

    // Verifica: il cwd deve stare DENTRO la base
    if (!isInsideDir(cwdReal, wtBase)) continue;

    // La root della worktree e' il secondo componente dopo la base:
    // ~/.topics/worktrees/<project-slug>/<worktree-name>
    const parts = relative(wtBase, cwdReal).split(sep).filter(Boolean);
    if (parts.length < 2) continue;
    const worktreeRoot = join(wtBase, parts[0]!, parts[1]!);

    if (existsSync(worktreeRoot)) continue; // ancora viva

    // Fantasma confermato
    const pid = sp.pid as number;
    // Recupera le porte per il log
    const ports = await getPortsForProcess(pid).catch(() => [] as number[]);
    console.log(
      `[ghost-reap] pid=${pid} port=${ports.join(",") || "?"} cwd sparito (${worktreeRoot}) — ` +
      (GHOST_REAP_ARMED ? "KILLING" : "only log (imposta TOPICS_GHOST_REAP=1 per armare)"),
    );

    if (GHOST_REAP_ARMED) {
      try {
        await killProcessTree(pid, 2000);
      } catch (err) {
        console.warn(`[ghost-reap] killProcessTree(${pid}) fallito:`, err);
      }
      // Rimuovi dal registro dopo aver ucciso
      runningScripts.delete(sp.processId);
      saveState();
      changed = true;
    }
  }
  return changed;
}
