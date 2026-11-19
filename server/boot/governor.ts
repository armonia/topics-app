/**
 * Budget governor, swap brake and freezer, and the dispatch tick.
 */
import { createSwapFreezer, oneLine } from "../services/swap-freeze";
import { setActiveSwapFreezer, setSwapFreezeBroadcast, announceSwapFreeze } from "../lib/swap-freeze-hold";
import { readProcessStates, readProcessTable, readStartTimes } from "../lib/process-snapshot";
import { createXpcAttribution, printPidDomain } from "../lib/xpc-attribution";
import { establishedPeers, outsidePeersOf } from "../lib/tree-network-peers";
import { appendFrozenNote, stdoutFileOf } from "../lib/background-shell-output";
import { backgroundBashFor, foregroundBashFor } from "../lib/background-bash-record";
import { listNativeCommands, nativeCommandByPid } from "../lib/native-command-registry";
import { listSessionCliPids } from "../providers/session-pids";
import { dispatchReconcileHeld } from "../lib/e2e-dispatch-hold";
import { getAgentPtyCliPids, retireTerminalSession } from "../routes/terminal";
import { refreshLiveJobQuotas } from "../services/agent-job-quota";
import { governorRead } from "../services/dispatch-capacity";
import { formatMemorySignalLine } from "../services/mem-signal";
import { fleetLoadSync, getFleetUsage, procFootprintKB, procResidentKB, registeredFleetSocketPaths } from "../lib/fleet-usage";
import { treeFootprintKB } from "../lib/card-memory-peaks";
import { machineCores } from "../lib/machine-cores";
import { createBudgetGovernor, freezableRuns, liveCheckTreeGB, setActiveBudgetGovernor, signalProcessTree } from "../services/budget-governor";
import { createSwapBrake, killCheckTree } from "../services/review-checks-brakes";
import { getDescendantPids } from "../lib/process-tree";
import { orphanChildSessions } from "../services/agent-census";
import { closeSystemCycle, openSystemCycle } from "../attention/system-notices";
import { totalmem as osTotalmem } from "node:os";
import { budgetShare, capMode } from "../../shared/board";
import type { AfterListen } from "./scope";
import { late } from "./late";
import { dispatcherLogLine } from "../services/task-dispatcher-support";

export function bootGovernor(scope: AfterListen) {
  const { broadcastToAll, claudeSessionTracker, ctx, db, delegatedRevocations, dispatcherSvc, memSignal, memoryOwners, memoryPressureSignal, recordDispatchMemoryHistory, swapFreezeLedger, taskDispatcher, turniInVolo } = scope;
  // Task auto-dispatch reconciliation: on boot, requeue any in-progress task whose
  // agent turn died with the previous process; then poll to fill free slots on
  // boards with auto_dispatch on (also the safety net if a →todo hook is missed).
  // Con auto_dispatch OFF è il TICK a essere un no-op, non l'intera reconcile: il
  // recupero degli orfani gira comunque, ed è voluto — una board spenta non
  // reclama, ma deve poter liberare le sue card ferme (la riga qui diceva
  // "reconcile() is a no-op", e ha mandato a caccia nel posto sbagliato chi
  // cercava perché sette fantasmi `queued` non venissero mai recuperati).
  const DISPATCH_POLL_MS = 10_000;


  /**
   * THE GOVERNOR OF WHAT IS ALREADY RUNNING, on the same ten-second beat as the
   * dispatch poll.
   *
   * The admission gate decides what STARTS; this one decides what keeps running.
   * Same beat on purpose: two clocks reading the same machine would take turns
   * describing two different instants, and the freeze would fight the admission.
   * Only in "by resources" mode, because a budget nobody set is not a budget:
   * `read()` returning `null` means "not measurable", and a governor that cannot
   * measure freezes nothing.
   */
  /** When the governor stopped each native command, to hand the deadline back what the pause took. */
  const governorFrozenAt = new Map<number, number>();

  /**
   * The commands the agents run inside their own tree, screened by the swap
   * freezer's own rules, as targets for the CPU governor. A native command has a
   * deadline that must stop counting while it is stopped; a background shell has
   * none. The "frozen for swap" line in the shell's output is NOT written: it names
   * a cause that is not this one.
   */
  async function agentCommandsForGovernor() {
    return (await swapFreezer.freezableCommands()).map(({ root, startedAt }) => ({
      id: `cmd:${root.pid}`,
      pid: root.pid,
      name: oneLine(root.command, 60),
      taskId: root.taskId ?? undefined,
      startedAt,
      ...(root.kind === "native" ? {
        onFreeze: () => { governorFrozenAt.set(root.pid, Date.now()); nativeCommandByPid(root.pid)?.onFreeze(); },
        onThaw: () => {
          const at = governorFrozenAt.get(root.pid);
          governorFrozenAt.delete(root.pid);
          nativeCommandByPid(root.pid)?.onThaw(at === undefined ? 0 : Date.now() - at);
        },
      } : {}),
    }));
  }

  const budgetGovernor = createBudgetGovernor({
    read: () => {
      try {
        const cap = dispatcherSvc.getGlobalCap();
        if (capMode(cap) !== "resources") return null;
        const fleet = fleetLoadSync();
        if (!fleet) return null;
        const share = budgetShare(cap);
        return governorRead(fleet, share, memSignal.latestAvailGB(), machineCores(), osTotalmem() / 1e9, turniInVolo());
      } catch { return null; }
    },
    signalTree: signalProcessTree,
    agentCommands: agentCommandsForGovernor,
    // Same ledger as the swap freezer: a tree the governor stopped is continued
    // at the next boot if this server dies first (`thawLedgerAtBoot`).
    record: async (id, pid) => {
      const pids = [pid, ...(await getDescendantPids(pid, { fresh: true }))];
      const starts = await readStartTimes(pids);
      const rootLstart = starts?.get(pid);
      if (!starts || !rootLstart) throw new Error(`no identity for pid ${pid}`);
      const treeId = `governor:${id}`;
      swapFreezeLedger.begin({ treeId, sessionKey: treeId, frozenAt: Date.now(), root: { pid, lstart: rootLstart } });
      swapFreezeLedger.addBatch(treeId, {
        groups: [{ pgid: pid, leaderLstart: rootLstart }],
        pids: pids.flatMap((p) => (starts.get(p) ? [{ pid: p, lstart: starts.get(p)! }] : [])),
      });
    },
    release: (id) => swapFreezeLedger.release(`governor:${id}`),
    log: (m) => console.log(`[budget] ${m}`),
    note: (taskId, text) => {
      try { dispatcherSvc.addComment({ taskId, author: "system", kind: "service", content: text }); }
      catch { /* a note that cannot be written must not stop the freeze */ }
    },
  });

  setActiveBudgetGovernor(budgetGovernor);


  taskDispatcher.reconcile({ reason: "boot" }).catch((err) => console.error(dispatcherLogLine("boot reconcile failed"), err));

  /** Under sustained swap the youngest heavy check round is interrupted, never red, and restarts by itself. */
  const swapBrake = createSwapBrake({
    kill: killCheckTree,
    note: (taskId, text) => {
      try { dispatcherSvc.addComment({ taskId, author: "system", kind: "service", content: text }); }
      catch { /* a note that cannot be written must not stop the brake */ }
    },
    log: (line) => console.warn(line),
  });


  /**
   * AND UNDER THE SAME SWAP, THE HEAVIEST COMMAND AN AGENT LAUNCHED IN THE
   * BACKGROUND IS FROZEN (`server/services/swap-freeze.ts`).
   *
   * Order on the beat: the brake first (it kills a check round, which gives memory
   * back and restarts by itself), the freezer only when the brake found nothing.
   * The two share one 120 s window, so neither measures the other's effect.
   */
  const swapFreezeXpc = createXpcAttribution({ print: printPidDomain });

  /** The card a session works on, the same reading `isChecksHold` makes. */
  function taskIdForSessionKey(sessionKey: string): string | null {
    const prefix = sessionKey.startsWith("topic:") ? sessionKey.slice("topic:".length) : sessionKey;
    if (!prefix) return null;
    try {
      const row = db.prepare(
        `SELECT id FROM tasks WHERE assigned_topic_id LIKE ? AND status IN ('in_progress','review') LIMIT 1`,
      ).get(prefix + "%") as { id: string } | null;
      return row?.id ?? null;
    } catch { return null; }
  }

  /** Every agent with a CLI alive: panes first, then the chats. */
  function agentSessionRefs() {
    const refs: Array<{
      sessionKey: string; cliPid: number; topicId: string | null; terminalId: string | null;
      taskId: string | null; backgroundBash: { command: string; startedAt: number }[]; foregroundBash: string[];
    }> = [];
    const seen = new Set<string>();
    for (const pty of getAgentPtyCliPids()) {
      seen.add(pty.sessionId);
      refs.push({
        sessionKey: pty.sessionId, cliPid: pty.pid, topicId: pty.topicId, terminalId: pty.sessionId,
        taskId: taskIdForSessionKey(pty.sessionId),
        backgroundBash: pty.claudeSessionId ? backgroundBashFor(pty.claudeSessionId) : [],
        foregroundBash: pty.claudeSessionId ? foregroundBashFor(pty.claudeSessionId) : [],
      });
    }
    for (const { sessionKey, pid } of listSessionCliPids()) {
      if (!sessionKey || pid <= 0 || seen.has(sessionKey)) continue;
      const claudeSessionId = (() => {
        try { return claudeSessionTracker.getSessionByKey(sessionKey)?.claudeSessionId ?? null; } catch { return null; }
      })();
      refs.push({
        sessionKey, cliPid: pid,
        topicId: (() => { try { return ctx.getTopicBySessionKey(sessionKey)?.id ?? null; } catch { return null; } })(),
        terminalId: null,
        taskId: taskIdForSessionKey(sessionKey),
        backgroundBash: claudeSessionId ? backgroundBashFor(claudeSessionId) : [],
        foregroundBash: claudeSessionId ? foregroundBashFor(claudeSessionId) : [],
      });
    }
    return refs;
  }

  /** Where a frozen background shell writes, captured while it is still readable. */
  const frozenShellOutputs = new Map<number, string>();

  const swapFreezer = createSwapFreezer({
    processTable: readProcessTable,
    footprintKB: procFootprintKB,
    residentKB: procResidentKB,
    lstartOf: readStartTimes,
    statOf: readProcessStates,
    signal: (pid, sig) => { process.kill(pid, sig); },
    sessions: agentSessionRefs,
    natives: () => listNativeCommands().map((n) => ({
      sessionKey: n.sessionKey,
      pid: n.pid,
      command: n.command,
      topicId: (() => { try { return ctx.getTopicBySessionKey(n.sessionKey)?.id ?? null; } catch { return null; } })(),
      terminalId: null,
      taskId: taskIdForSessionKey(n.sessionKey),
    })),
    guardRoles: (rows) => {
      const cliPids = [
        ...getAgentPtyCliPids().map((p) => p.pid),
        ...listSessionCliPids().map((p) => p.pid),
      ];
      return { serverPid: process.pid, sidecarPids: sidecarPidsNow(rows), cliPids };
    },
    xpcServicePids: (appPid, appCommand, commandOf) => swapFreezeXpc.servicePidsOf(appPid, appCommand, commandOf),
    // `null` travels: an `lsof` that did not answer is not a tree with no clients.
    outsidePeers: async (pids) => {
      const rows = await establishedPeers();
      return rows === null ? null : outsidePeersOf(rows, new Set(pids));
    },
    ledger: swapFreezeLedger,
    log: (line) => console.warn(line),
    // The same census the first-card exemption of the dispatcher reads: cards in
    // flight plus pre-review check runs.
    ourWorkInFlight: () => turniInVolo() + (late.checksGateRunningCount?.() ?? 0),
    note: (taskId, text) => {
      try { dispatcherSvc.addComment({ taskId, author: "system", kind: "service", content: text }); }
      catch { /* a note that cannot be written must not stop the freeze */ }
    },
    onFreezeTree: (root) => {
      if (root.kind === "native") { try { nativeCommandByPid(root.pid)?.onFreeze(); } catch { /* the freeze holds anyway */ } return; }
      // The agent is told through the file its own `BashOutput` reads, and the
      // path has to be resolved while the shell is still there to be asked.
      void stdoutFileOf(root.pid).then((path) => { if (path) frozenShellOutputs.set(root.pid, path); }).catch(() => {});
    },
    onThawTree: (root, frozenMs) => {
      if (root.kind === "native") { try { nativeCommandByPid(root.pid)?.onThaw(frozenMs); } catch { /* it resumes anyway */ } return; }
      const path = frozenShellOutputs.get(root.pid);
      frozenShellOutputs.delete(root.pid);
      if (path) appendFrozenNote(path, frozenMs);
    },
    announce: (event) => {
      announceSwapFreeze();
      try {
        // A fact about the Mac, not about the chat that owns the command: a row of
        // kind `system`, one per freeze cycle, the thaw rewriting the freeze's row
        // (notifications-redesign, ATTN-10, defect D5).
        const it = event.view;
        const key = `swap-freeze:${it.id}`;
        if (event.kind === "frozen") {
          openSystemCycle(key, {
            title: `Congelato: ${it.command}`, // allow-italian: notification history is written in Italian like every other row
            body: `Il Mac e' in swap: il comando tiene ${it.footprintGB.toFixed(1)} GB e riprende entro 10 minuti.`, // allow-italian: same row
          });
        } else {
          closeSystemCycle(key, {
            title: `Congelato e ripreso: ${it.command}`, // allow-italian: same row
            body: `Ripreso dopo ${Math.round(event.frozenMs / 1000)} s (${event.reason}).`, // allow-italian: same row
          });
        }
      } catch { /* a notification that cannot be written must not stop the freeze */ }
    },
  });

  setActiveSwapFreezer(swapFreezer);

  setSwapFreezeBroadcast((views) => broadcastToAll({ type: "swap-freeze:state", views }));

  /** The sidecars (pty bridge, ai-bridge, webrtc), found on the freezer's own table
   *  by the socket paths they registered themselves with `registerFleetSocket`. */
  function sidecarPidsNow(rows: readonly { pid: number; command: string }[]): number[] {
    const paths = registeredFleetSocketPaths();
    if (paths.length === 0) return [];
    return rows
      .filter((row) => row.pid !== process.pid && paths.some((sock) => row.command.includes(sock)))
      .map((row) => row.pid);
  }


  /** The `[memsig]` line goes out once a minute on the 10 s beat. */
  const MEMSIG_EVERY_MS = 60_000;

  let memsigAt = 0;

  const dispatchTimer = setInterval(() => {
    void memSignal.sample().then(() => {
      recordDispatchMemoryHistory();
      memoryPressureSignal.update(memSignal.swap().sustained);
      // THE BRAKE FIRST, THE FREEZER AFTER, ON ONE WINDOW. The brake kills a check
      // round (memory back, no verdict lost); the freezer only stops an agent's
      // heaviest background command, which gives nothing back. Whichever acts,
      // the other waits 120 s: `lastActionAt` is the shared clock.
      const brake = swapBrake.tick(memSignal.swap(), freezableRuns(), swapFreezer.lastActionAt());
      void swapFreezer.tick({ swap: memSignal.swap(), held: memSignal.held(), brake })
        .catch((err) => console.error("[freeze] tick failed", err));
      const now = Date.now();
      if (now - memsigAt < MEMSIG_EVERY_MS) return;
      memsigAt = now;
      // The same minute weighs the local cards in flight: the server's whole tree
      // against its idle baseline (`dispatch-card-weight.ts`).
      void treeFootprintKB(process.pid)
        .then((kb) => taskDispatcher.sampleCardWeight(kb == null ? null : (kb * 1024) / 1e9))
        .catch((err) => console.error("[card-weight] sample failed", err));
      return memoryOwners.sample().then(() => {
        const samples = memSignal.samples();
        console.log(formatMemorySignalLine({
          at: now, held: memSignal.held(), swap: memSignal.swap(), latest: samples[samples.length - 1] ?? null,
          inFlight: turniInVolo(), checkRuns: freezableRuns().length, heaviestCheckGB: liveCheckTreeGB(),
          frozenTrees: swapFreezer.frozenCount(), frozenGB: swapFreezer.frozenGB(),
          foreign: memoryOwners.latest(),
        }));
      });
    }).catch((err) => console.error("[memsig] sample failed", err));
    // THE E2E BENCH CAN HOLD THIS ONE STEP, and nothing else can: the only writer
    // is a route mounted on a test server. See `lib/e2e-dispatch-hold.ts` for the
    // race it closes — a staged fake agent recovered mid-gesture.
    // A fresh reading per beat (TTL 4 s, ps ~0.1 s), taken BEFORE both the
    // admission and the governor: they decide on the same instant, so the freeze
    // never fights the admission and neither judges a 30 s old cache.
    const freshFleet = getFleetUsage().catch(() => {});
    if (!dispatchReconcileHeld()) {
      void freshFleet
        .then(() => taskDispatcher.reconcile({ reason: "poll" }))
        .catch((err) => console.error(dispatcherLogLine("poll reconcile failed"), err));
    }
    void delegatedRevocations.tick().catch((err) => console.error("[delegated-revoke] retry failed", err));
    void freshFleet.then(() => budgetGovernor.sampleOnce()).catch((err) => console.error("[budget] sample failed", err));
    // LA QUOTA DI CORE SI RILEGGE QUI, sullo stesso giro che fa nascere e morire
    // gli agenti — cioè l'unico momento in cui il denominatore («quanti stanno
    // compilando accanto a me») può essere cambiato. L'ambiente di un processo si
    // scrive una volta sola, allo spawn: senza questa riga un agente rimasto solo
    // su dodici core continuerebbe a compilare con la fetta di quando erano in
    // quattro, e il prezzo del recinto lo pagherebbe per niente.
    // Sta in server.ts e non dentro `reconcile()` per la stessa ragione di tutto
    // il resto del cablaggio: il dispatcher resta host-agnostico e testabile.
    try { refreshLiveJobQuotas(ctx.db); }
    catch (err) { console.error("[job-quota] rilettura viva fallita", err); }
    // LE FIGLIE MUOIONO COL PADRE, e qui è dove si scopre che è morto. La cascata
    // del bridge copre solo un padre TERMINALE; la sessione di un task è una chat,
    // e nessun frame `exit` la riguarda. Una spazzata sullo stesso giro che fa
    // nascere e morire gli agenti risponde alla domanda giusta — «il task ha
    // ancora un agente vivo?» — su OGNI strada di uscita, invece che su quelle
    // che ci siamo ricordati di agganciare.
    // Il padre però non è sempre un task: un sotto-agente aperto da una chat
    // qualunque non aveva NESSUNO addosso — non la cascata (che vuole un padre
    // terminale), non il parcheggio (`tryParkSession` rifiuta chi ha un
    // `parentSessionKey`), non questa spazzata (che faceva JOIN su `tasks`). Il
    // suo PTY sopravviveva all'archiviazione della chat per sempre.
    // `orphanChildSessions` chiede la stessa domanda alle due forme di padre.
    try {
      for (const id of orphanChildSessions(ctx.db)) retireTerminalSession(id, "swept", "orphan-child-sweep");
    } catch (err) { console.error("[board] reap delle sessioni figlie fallito", err); }
  }, DISPATCH_POLL_MS);

  return { budgetGovernor, dispatchTimer, swapFreezer };
}
