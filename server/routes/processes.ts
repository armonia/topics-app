import type { AppContext, RouteHandler } from "../types";
import { sliceFromCursor } from "../lib/log-cursor";
import { detectScripts, resolveScript, MANIFESTS } from "../lib/project-scripts";
import { augmentEnv, wrapPty, stripAnsi } from "../utils/path-env";
import { killProcessTree } from "../lib/process-tree";
import { getTerminalSessionById } from "./terminal";
import { shellProcessKey } from "../../shared/background-shell-registry";
import { awaitProcess, clampWaitTimeout, compileUntil, openWatch, watchesForProcess, WAIT_DEFAULT_TIMEOUT_MS } from "../lib/process-wait";
import { isGlobalOrchestratorSession } from "../services/global-orchestrator-session";
import { commandGroupArgv, confineCommandCwd } from "../lib/command-process";
import { captureProcessGroup, closeCommandProcessGroup, commandProcessGroupStopPath, commandProcessGroup, forgetCommandProcessGroupIfGone, processGroupAlive, processGroupIdentityMatches, registerCommandProcessGroup, type ProcessGroupIdentity } from "../lib/command-process-groups";
import { cardIdForTopic, reconcileClosedCommandProcesses } from "./command-process-lifecycle";
import { closeLostRun } from "../lib/command-runs";
import { createCommandRunsRoute } from "./command-runs";
import { isWatchedBySession } from "../lib/process-wait";
import { pushBackgroundChanged } from "../lib/command-background";
import { isPidAlive } from "../lib/pid-liveness";
import { commandGroupHooks, commandServiceWatch, settlePersonRun, settleWakeReadInTurn, startCommandProcess, stopCommand } from "./processes-commands";
import { bumpProcessDetection } from "./processes-detection";
import { addToRecent, appendOutput, trimRecent } from "./processes-output";
import { SCRIPTS_CACHE_TTL, exitPathOf, invalidateScriptsCache, loadProcessRegistry, logPathOf, pidStartTime, saveState } from "./processes-persist";
// Evaluated for its hook: it installs the registry restore that loadProcessRegistry runs.
import "./processes-restore";
import { finishBackgroundShell, sweepOrphanedShellTree } from "./processes-shells";
import { broadcastScriptsUpdate, getPortsForProcesses, notifyScriptOutput, publicRow } from "./processes-snapshot";
import { MAX_RECENT, type ScriptProcess, isPersonRun, recentScripts, runningScripts, scriptsResponseCache, setScriptsResponseCache, setBroadcastCtx } from "./processes-state";

export { commandBackgroundWork, commandServices, topicCommandProcesses, liveCommandsOf, isChatServerTask, commandWakeState, stopCommandWakesOf, sessionsAwaitingCommandWake } from "./processes-commands";
export { DETECTION_INTERVAL_MS, DETECTION_INTERVAL_MAX_MS, GHOST_CWD_PROBE_MIN_INTERVAL_MS, processDetectionViewIsOpen, ghostCwdProbeDue, nextDetectionDelay, startProcessDetection, stopProcessDetectionForTests, bumpProcessDetection } from "./processes-detection";
export { logPathOf, readoptVerdict, loadProcessRegistry } from "./processes-persist";
export { registerPreviewProcess, trackedScriptPidTrees, unregisterPreviewProcess, registerBackgroundShell, settleEndedShells, noteBackgroundShellOutput, closeBackgroundShell, listBackgroundShells, esitoShellMorta, captureShellTree, sweepOrphanedShellTree } from "./processes-shells";
export { listOwnedScripts, listSessionOwnedProcesses, listUnownedScriptPids, getScriptsSnapshot } from "./processes-snapshot";
export {
  stopCardCommandProcesses, stopTopicCommandProcesses,
} from "./command-process-lifecycle";

export function createProcessesRouter(ctx: AppContext): RouteHandler {
  loadProcessRegistry();
  const { json } = ctx;
  setBroadcastCtx(ctx); // store for pollPidExit callbacks
  reconcileClosedCommandProcesses(ctx.db);
  // The people's runs that ended before there was a database to close their row in (boot):
  // every one closed first, the rows past MAX_RECENT dropped after.
  for (const sp of recentScripts) if (isPersonRun(sp)) settlePersonRun(sp);
  if (recentScripts.length > MAX_RECENT) { trimRecent(); saveState(); }

  async function readJSON(req: Request): Promise<any> {
    try { return await req.json(); } catch { return null; }
  }

  /** TOPICS_PORT for a worktree Topics manages; a main checkout runs with its own defaults. */
  function worktreePortEnv(projectPath: string): { TOPICS_PORT?: string } {
    const port = ctx.worktreeManager.knownWorktreePort(projectPath);
    return port === null ? {} : { TOPICS_PORT: String(port) };
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
    owner?: { sessionKey: string; cardId: string; topicId: string | null },
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
    const ptyArgv = useTty ? wrapPty(base) : base;
    const argv = owner ? commandGroupArgv(ptyArgv, commandProcessGroupStopPath(processId)) : ptyArgv;

    const proc = Bun.spawn(argv, {
      cwd: projectPath,
      stdout: "pipe",
      stderr: "pipe",
      ...(owner && process.platform !== "win32" ? { detached: true } : {}),
      env: augmentEnv(process.env, {
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        HOST: "0.0.0.0",
        NODE_ENV: "development",
        npm_config_yes: "true",
        ...worktreePortEnv(projectPath),
      }),
    });
    const startedAt = new Date().toISOString();
    if (owner) {
      let identity: ProcessGroupIdentity | null;
      try { identity = captureProcessGroup(proc.pid); }
      catch (error) { try { proc.kill("SIGKILL"); } catch { /* the leader may already be dead; the original error is rethrown */ } throw error; }
      if (identity) {
        try {
          registerCommandProcessGroup({
            processId, ownerKey: owner.sessionKey, cardId: owner.cardId, topicId: owner.topicId,
            pgid: identity.pgid, leaderPid: identity.pid, leaderStartTime: identity.startTime, startedAt,
          });
        } catch (error) {
          if (processGroupIdentityMatches(identity) && processGroupAlive(identity.pgid)) {
            try { process.kill(-identity.pgid, "SIGKILL"); } catch { /* the group may already be gone; the original error is rethrown */ }
          }
          throw error;
        }
      }
    }

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
      startedAt,
      output: [],
      outputBytes: 0,
      proc,
      ...(owner ? { cardRun: owner, agentRun: { sessionKey: owner.sessionKey, topicId: owner.topicId } } : {}),
    };

    runningScripts.set(processId, sp);
    saveState();
    broadcastScriptsUpdate(ctx);

    const drainInto = (stream: ReadableStream<Uint8Array>) => void drainOutput(stream, processId, (text) => {
      appendOutput(sp, useTty ? stripAnsi(text) : text);
      notifyScriptOutput(ctx, processId);
    });
    if (proc.stdout) drainInto(proc.stdout as ReadableStream<Uint8Array>);
    if (proc.stderr) drainInto(proc.stderr as ReadableStream<Uint8Array>);

    proc.exited.then((exitCode) => {
      if (sp.closing || sp.stopFailed) return;
      sp.status = exitCode === 0 ? "done" : "error";
      sp.exitCode = exitCode;
      sp.completedAt = new Date().toISOString();
      sp.proc = null;
      runningScripts.delete(processId);
      addToRecent(sp);
      saveState();
      broadcastScriptsUpdate(ctx);
      // An agent's server ended: its chat says so now, not at the next poll.
      if (sp.agentRun) pushBackgroundChanged(ctx, sp.agentRun);
      forgetCommandProcessGroupIfGone(sp.processId);
    });

    return { processId, scriptName: rilevato.name, pid: proc.pid, startedAt: sp.startedAt };
  }

  // ── Session scoping helpers (shared by MCP-bridge session endpoints) ──────

  /** Resolve a sessionKey to its topic's working directory, or an error Response. */
  function resolveSessionCwd(sessionKey: string): { path: string } | { error: Response } {
    // The registered board coordinator deliberately has no project authority.
    // This must use the raw registry predicate, rather than its usable global
    // capability: a manually corrupted/bound coordinator must not fall through
    // to ordinary topic or terminal cwd resolution and gain script authority.
    if (isGlobalOrchestratorSession(ctx.db, sessionKey)) {
      return {
        error: json({
          error: "the global coordinator cannot access project scripts",
          code: "orchestrator_topic_invariant",
        }, 403),
      };
    }
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
  async function serializeScripts(filterCwd?: string, withPorts = true): Promise<{ scripts: any[] }> {
    // Scoped to a session = the agent asking (`list_processes`): a person's run is not its to see.
    const match = (sp: ScriptProcess) => !filterCwd || (sp.projectPath === filterCwd && !isPersonRun(sp));
    const running = Array.from(runningScripts.values()).filter(match);
    // One batched port lookup for all running pids (shared lsof + ps snapshot,
    // single pass over the cached port list) instead of per-process. Without
    // `withPorts` none at all: the rows go out with no ports.
    const portsByPid = withPorts
      ? await getPortsForProcesses(running.map(sp => sp.pid).filter((p): p is number => !!p))
      : new Map<number, number[]>();
    // La spia dell'attesa viaggia con la riga che gia' si legge: un campo in
    // piu' qui costa niente e toglie il dubbio «l'agente e' fermo, o sta
    // aspettando proprio questo?». Assente quando nessuno aspetta, per non
    // gonfiare il payload piu' comune.
    const watchers = (sp: ScriptProcess) => {
      const w = watchesForProcess(sp.processId);
      return w.length ? { watchers: w } : {};
    };
    const runningList = running.map(sp => ({
      ...publicRow(sp),
      ports: sp.pid ? (portsByPid.get(sp.pid) ?? []) : [],
      ...watchers(sp),
    }));
    const recentList = recentScripts.filter(match).map(sp => ({ ...publicRow(sp), ports: [] as number[] }));
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
      // The followed file's line being written shows like the log's own.
      pendingLine: sp.pendingLine || sp.followPending || "",
    }, offset);
    // What an empty log is waiting for, and since when: the file its stdout
    // goes to, or the one nobody can follow (chat-live-work).
    return {
      ...slice, done: sp.status !== "running", status: sp.status, exitCode: sp.exitCode, startedAt: sp.startedAt,
      ...(sp.cmd?.follow ? { follows: sp.cmd.follow.path } : {}),
      ...(sp.cmd?.unfollowed ? { unfollowed: sp.cmd.unfollowed } : {}),
    };
  };

  /**
   * Terminate a running script (process-group kill + delayed SIGKILL) and clean up.
   * Torna `false` quando non c'è niente da ammazzare: una shell il cui processo
   * non è ancora stato individuato nell'albero del CLI. Togliere la riga in quel
   * caso sarebbe la bugia peggiore — il processo resterebbe vivo, ma invisibile.
   */
  function killRunningScript(sp: ScriptProcess): boolean {
    if (sp.cmd) {
      stopCommand(sp);
      return true;
    }
    const group = sp.cardRun ? commandProcessGroup(sp.processId) : undefined;
    if (group) {
      void closeCommandProcessGroup(group, commandGroupHooks);
      return true;
    }
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
      // `killProcessTree` reads a FRESH process table: the cached one is up to
      // 2 s old and misses a worker forked inside that window, which then
      // survives the Stop with its port. Not a group kill (see above).
      if (dpid && isPidAlive(dpid)) void killProcessTree(dpid, 5000);
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
      try { process.kill(pid, "SIGTERM"); } catch { /* the process may already have exited */ }
    }
    setTimeout(() => {
      // Identity guard: if OUR process already exited (proc.exited handler set
      // status + removed it from runningScripts within the grace), the pid may
      // have been recycled by the OS — SIGKILLing it now could hit an unrelated
      // fresh process. Our own bookkeeping is the authoritative liveness check.
      if (sp.status !== "running") return;
      try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch { /* the process may have exited during the grace period */ }
    }, 5000);
    return true;
  }

  // Run under a code block of a reply (`routes/command-runs.ts`): this registry runs it.
  const commandRunsRoute = createCommandRunsRoute(ctx, {
    start: (o) => startCommandProcess({ projectPath: o.cwd, ...o, wake: false, origin: "person", db: ctx.db }),
    reconcile(runId) {
      const sp = getScript(runId);
      if (!sp) return "gone";
      if (sp.status === "running") return "running";
      settlePersonRun(sp);
      return "ended";
    },
    closeLost: (runId, startedAt) => closeLostRun(ctx, { processId: runId, startedAt, exitPath: exitPathOf(runId), logPath: logPathOf(runId) }),
    kill(runId) { const sp = runningScripts.get(runId); if (sp) killRunningScript(sp); },
  });

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
          return json({ error: `No script manifest in ${projectPath} (looked at: ${MANIFESTS.join(", ")})` }, 400);
        }
        if (!resolveScript(rilevati, scriptName)) {
          return json({
            error: `The script "${scriptName}" is not declared in this project`,
            available: rilevati.scripts.map(x => x.id),
          }, 400);
        }

        const useTty = body?.tty !== false;
        try {
          const topic = ctx.getTopicBySessionKey(sessionKey);
          const cardId = cardIdForTopic(ctx.db, topic?.id ?? null);
          const owner = cardId ? { sessionKey, cardId, topicId: topic?.id ?? null } : undefined;
          const started = startScriptProcess(projectPath, scriptName, useTty, owner);
          // The agent's chat owns it: a dev server shows there as a server.
          const sp = runningScripts.get(started.processId);
          if (sp) {
            sp.agentRun = { sessionKey, topicId: topic?.id ?? null };
            commandServiceWatch.kick();
          }
          return json(started);
        } catch (err: any) {
          return json({ error: `Failed to spawn: ${err.message}` }, 500);
        }
      }
    }

    // POST /api/sessions/:sessionKey/commands/run — any command (MCP `run_command`)
    //
    // The gate above stays as it is: an arbitrary command has its own door
    // instead of a parameter that makes the manifest optional. What it does
    // not open is a new power: the agent behind this session already has
    // `Bash`, and the command runs in that Bash's environment, not the
    // server's (`lib/agent-env.ts`). It gets a place where the work is seen,
    // stopped, survives the CLI, and reports back. Same scoping as the
    // scripts: the session resolves the project, and the cwd cannot leave it.
    {
      const m = method === "POST" && pathname.match(/^\/api\/sessions\/([^/]+)\/commands\/run$/);
      if (m) {
        const sessionKey = decodeURIComponent(m[1]);
        const body = await readJSON(req);
        const command = typeof body?.command === "string" ? body.command.trim() : "";
        if (!command) return json({ error: "command (non-empty string) is required" }, 400);
        const r = resolveSessionCwd(sessionKey);
        if ("error" in r) return r.error;
        const cwd = confineCommandCwd(r.path, body?.cwd);
        if (!cwd) return json({ error: `cwd must be an existing directory inside ${r.path}` }, 400);
        try {
          const started = startCommandProcess({
            projectPath: r.path, cwd, command, sessionKey, description: body?.description,
            topicId: ctx.getTopicBySessionKey(sessionKey)?.id ?? null,
            wake: body?.wake !== false, db: ctx.db,
          });
          if (!started) return json({ error: "run_command needs a POSIX shell, and this system has none" }, 501);
          return json(started);
        } catch (err) {
          return json({ error: `Failed to spawn: ${err instanceof Error ? err.message : String(err)}` }, 500);
        }
      }
    }

    const runs = await commandRunsRoute(req, url, pathname, method);
    if (runs) return runs;

    // GET /api/scripts — list running + recent; per-process ports with `?ports=1`
    if (method === "GET" && pathname === "/api/scripts") {
      // `?ports=1` is the Processes panel, the one reader that draws ports, and
      // someone looking at it: the detection goes back to full cadence, so the
      // backoff does not keep a server just started waiting half a minute.
      // Before the cache, because the request is the sign of interest. Every
      // project sidebar polls this route too, every 15 s, for its running
      // dots: when that poll read the ports and woke the detection, lsof ran
      // every 4 s for as long as a window was open (238 in 15 minutes,
      // measured in production on 15/10).
      const withPorts = url.searchParams.get("ports") === "1";
      if (withPorts) bumpProcessDetection();
      // Server-side cache check (2s TTL): an answer with ports also serves a poll without.
      const cached = scriptsResponseCache;
      if (cached && Date.now() - cached.timestamp < SCRIPTS_CACHE_TTL && (cached.ports || !withPorts)) {
        return json(cached.data);
      }
      const scriptsResult = await serializeScripts(undefined, withPorts);
      setScriptsResponseCache({ data: scriptsResult, timestamp: Date.now(), ports: withPorts });
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
        return json({ error: "shell_pid_unknown", message: "Process not located yet: stop it from the chat with KillShell." }, 409);
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
        const sessionKey = decodeURIComponent(m[1]);
        const r = resolveSessionCwd(sessionKey);
        if ("error" in r) return r.error;
        const sp = getScript(m[2]);
        if (!sp || sp.projectPath !== r.path || isPersonRun(sp)) {
          return json({ error: "Process not found in this project" }, 404);
        }
        const offset = parseInt(url.searchParams.get("offset") || "0", 10);
        const payload = outputPayload(sp, offset);
        // Only the agent's bridge calls this, from inside its turn.
        if (payload.done && ctx.activeStreams.has(sessionKey)) settleWakeReadInTurn(sp, sessionKey, ctx.db);
        return json(payload);
      }
    }

    // GET /api/sessions/:sessionKey/scripts/:id/wait — attesa, non sondaggio
    //
    // Tiene la richiesta aperta finche' il processo esce, finche' una riga
    // combacia con `until`, o finche' scade `timeout_ms`. Il turno del modello
    // e' uno solo: quello che chiede. Lo scadere NON e' un errore — e' la
    // risposta «ancora vivo», con l'output nuovo e il cursore per ripartire.
    //
    // `id` accetta anche l'id di una shell in background: e' l'unico handle che
    // l'agente ha delle proprie shell, e chiedergli di tradurlo a mano nella
    // chiave interna sarebbe un dettaglio nostro scaricato su di lui.
    {
      const m = method === "GET" && pathname.match(/^\/api\/sessions\/([^/]+)\/scripts\/([^/]+)\/wait$/);
      if (m) {
        const sessionKey = decodeURIComponent(m[1]);
        const r = resolveSessionCwd(sessionKey);
        if ("error" in r) return r.error;
        const id = decodeURIComponent(m[2]);
        const sp = getScript(id) ?? getScript(shellProcessKey(sessionKey, id));
        if (!sp || sp.projectPath !== r.path || isPersonRun(sp)) {
          return json({ error: "Process not found in this project" }, 404);
        }

        let until: RegExp | undefined;
        try {
          until = compileUntil(url.searchParams.get("until") ?? undefined);
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 400);
        }
        const timeoutMs = clampWaitTimeout(url.searchParams.get("timeout_ms") ?? WAIT_DEFAULT_TIMEOUT_MS);
        const offset = parseInt(url.searchParams.get("offset") || "0", 10);

        const topic = ctx.getTopicBySessionKey(sessionKey);
        const { close } = openWatch({
          processId: sp.processId,
          label: topic?.name || sessionKey,
          sessionKey,
          ...(until ? { until: until.source } : {}),
          timeoutMs,
        });
        // A caller that went away (its CLI restarted, its turn stopped, the
        // bridge died) is waiting no more: an open watch would make the end of
        // a command look already delivered, and its wake would go to nobody.
        req.signal?.addEventListener("abort", () => {
          close();
          invalidateScriptsCache();
          broadcastScriptsUpdate(ctx);
        }, { once: true });
        // La spia deve comparire SUBITO, non al prossimo giro di cache.
        invalidateScriptsCache();
        broadcastScriptsUpdate(ctx);
        try {
          const outcome = await awaitProcess({
            read: (cursor) => outputPayload(sp, cursor),
            offset: Number.isFinite(offset) ? offset : 0,
            ...(until ? { until } : {}),
            timeoutMs,
          });
          // The turn is live while its watch is open (`closeWatchesOfSession`).
          if (outcome.status !== "running" && isWatchedBySession(sp.processId, sessionKey)) settleWakeReadInTurn(sp, sessionKey, ctx.db);
          return json({ ...outcome, processId: sp.processId, scriptName: sp.scriptName });
        } finally {
          close();
          invalidateScriptsCache();
          broadcastScriptsUpdate(ctx);
        }
      }
    }

    // POST /api/sessions/:sessionKey/scripts/:id/stop
    {
      const m = method === "POST" && pathname.match(/^\/api\/sessions\/([^/]+)\/scripts\/([^/]+)\/stop$/);
      if (m) {
        const r = resolveSessionCwd(decodeURIComponent(m[1]));
        if ("error" in r) return r.error;
        const sp = runningScripts.get(m[2]);
        if (!sp || sp.projectPath !== r.path || isPersonRun(sp)) {
          return json({ error: "Process not found in this project or already stopped" }, 404);
        }
        if (!killRunningScript(sp)) {
          return json({ error: "shell_pid_unknown", message: "Process not located yet: use KillShell on the shell id." }, 409);
        }
        return json({ ok: true });
      }
    }

    return null;
  };
}

