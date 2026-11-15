import { createSwapFreezer, oneLine } from "../services/swap-freeze";
import { setActiveSwapFreezer, setSwapFreezeBroadcast, announceSwapFreeze } from "../lib/swap-freeze-hold";
import { readProcessStates, readProcessTable, readStartTimes } from "../lib/process-snapshot";
import { createXpcAttribution, printPidDomain } from "../lib/xpc-attribution";
import { establishedPeers, outsidePeersOf } from "../lib/tree-network-peers";
import { appendFrozenNote, stdoutFileOf } from "../lib/background-shell-output";
import { backgroundBashFor, foregroundBashFor } from "../lib/background-bash-record";
import { listNativeCommands, nativeCommandByPid } from "../lib/native-command-registry";
import { listSessionCliPids } from "../providers/session-pids";
import { getAgentPtyCliPids } from "../routes/terminal";
import { governorRead } from "../services/dispatch-capacity";
import { fleetLoadSync, procFootprintKB, procResidentKB, registeredFleetSocketPaths } from "../lib/fleet-usage";
import { machineCores } from "../lib/machine-cores";
import { createBudgetGovernor, setActiveBudgetGovernor, signalProcessTree } from "../services/budget-governor";
import { createSwapBrake, killCheckTree } from "../services/review-checks-brakes";
import { getDescendantPids } from "../lib/process-tree";
import { closeSystemCycle, openSystemCycle } from "../attention/system-notices";
import { totalmem as osTotalmem } from "node:os";
import { budgetShare, capMode } from "../../shared/board";
import type { BootScope } from "../../server";

export function createMemoryGovernor(d: {
  broadcastToAll: BootScope["broadcastToAll"];
  db: BootScope["db"];
  ctx: BootScope["ctx"];
  claudeSessionTracker: BootScope["claudeSessionTracker"];
  dispatcherSvc: BootScope["dispatcherSvc"];
  turniInVolo: BootScope["turniInVolo"];
  checksGateRunningCount: BootScope["checksGateRunningCount"];
  swapFreezeLedger: BootScope["swapFreezeLedger"];
  memSignal: BootScope["memSignal"];
  taskDispatcher: BootScope["taskDispatcher"];
}) {
  const { broadcastToAll, db, ctx, claudeSessionTracker, dispatcherSvc, turniInVolo, checksGateRunningCount, swapFreezeLedger, memSignal, taskDispatcher } = d;

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

  taskDispatcher.reconcile({ reason: "boot" }).catch((err) => console.error("[dispatcher] boot reconcile failed", err));
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
    ourWorkInFlight: () => turniInVolo() + (checksGateRunningCount?.() ?? 0),
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

  return { DISPATCH_POLL_MS, budgetGovernor, swapBrake, swapFreezer };
}
