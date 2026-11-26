/**
 * task-dispatcher-overflow.ts: moving a waiting card to a seat on another machine.
 * 
 * Origin and branch readiness caches, the per-round overflow clocks, machine load
 * and the reassignment away from a forbidden machine.
 */
import { type Task } from "./tasks";
import { BRANCH_NOWHERE_REASON, carriedBranch } from "./branch-on-origin";
import { nodeBlocked } from "./wake-breaker";
import { effectiveSlots, machineForbidden, machineLacksModel, pickReassignTarget, reassignNote, OVERFLOW_MAX_PER_ROUND, overflowEligible, overflowNoteImmediate, pickOverflowMachine, type OverflowMachine } from "./dispatch-overflow";
import { providerHold } from "../lib/provider-hold";
import { CLOUD_HOLD_KEY } from "../lib/cloud-weekly-limit";
import type { DispatcherCtx } from "./task-dispatcher-context";

export function createOverflow(ctx: DispatcherCtx) {
  const { clock, delegatedPolicy, deps, floorBlockSent, inFlight, log, memoryHeldCards, overflowBranch, overflowBranchPending, overflowOrigin, overflowOriginPending, overflowRounds } = ctx.core;

  const phantomBranches = new Map<string, Set<string>>();

  /**
   * A card that runs on ANOTHER machine (a paired node, or the Cloud Claude
   * runtime): `remoteLaunch` takes it over and this Mac spends no process, no
   * worktree and no gigabyte on it. Every gate that measures THIS machine's RAM
   * and CPU (the memory floor, the resources budget, the heavy hold, the ramp)
   * describes nothing about it, so they hold local cards only; a full disk, the
   * spend brakes and the plan window still hold it. The machine must answer at
   * an address, the same population `RUNS_HERE_SQL` leaves out of the census: a
   * stale row of this Mac (one per hostname) has none. An unknown local id or
   * address reads as local: the gates stay on rather than open.
   */
  /** The card's pinned machine declares 0 slots: it takes no new card, pinned ones included. */
  function pinnedMachineDrained(task: Task): boolean {
    if (!task.machineId || !deps.overflowMachines) return false;
    try { return deps.overflowMachines().some((m) => m.id === task.machineId && m.slots === 0); } catch { return false; }
  }
  /**
   * The card's pinned machine already runs as many cards as it has seats: the card
   * stays in Todo and no attempt is spent, instead of being claimed, refused at the
   * node and counted as a failed start. Cards of an unknown machine are not held.
   */
  function pinnedMachineFull(task: Task): boolean {
    if (!task.machineId || !deps.overflowMachines) return false;
    try {
      const m = deps.overflowMachines().find((x) => x.id === task.machineId);
      if (!m || m.slots === undefined) return false;
      const seats = effectiveSlots(m);
      if (seats <= 0) return false;
      return deps.svc.countRunningOnMachine(task.machineId, task.id) >= seats;
    } catch { return false; }
  }
  /**
   * A Todo card pinned to a machine that cannot run it (zero slots, or offline
   * with no way to wake it) moves to an allowed machine, or back here when none
   * is free, instead of waiting for ever. Delegated and mirror cards are bound
   * to their machine and stay. `true` = the card moved.
   */
  function reassignFromForbidden(
    t: Task,
    settings: { dispatchModel?: string | null },
  ): boolean {
    if (!t.machineId || !deps.overflowMachines) return false;
    if (delegatedPolicy(t) !== undefined || t.claudeTaskId?.startsWith("node-run:")) return false;
    let machines: OverflowMachine[] = [];
    try { machines = deps.overflowMachines(); } catch (err) { log("reassign: machine list failed", err); return false; }
    const pinned = machines.find((m) => m.id === t.machineId);
    const wantedModel = t.model ?? (settings.dispatchModel && settings.dispatchModel !== "auto" ? settings.dispatchModel : null);
    if (!pinned || !(machineForbidden(pinned, nodeBlocked) || machineLacksModel(pinned, wantedModel))) return false;
    let cloudCredit = true;
    try { cloudCredit = deps.cloudCredit?.() ?? (!providerHold() && !providerHold(Date.now(), CLOUD_HOLD_KEY)); } catch { cloudCredit = false; }
    const origin = overflowOriginOf(t.projectId);
    const target = pickReassignTarget(machines, pinned.id, {
      cloudCredit,
      githubOrigin: origin.github && !cloudRefusesProject(t.projectId),
      model: t.model ?? (settings.dispatchModel && settings.dispatchModel !== "auto" ? settings.dispatchModel : null),
      load: machineLoad,
      wakeBlocked: nodeBlocked,
    });
    try {
      const moved = deps.svc.update({ taskId: t.id, actor: "agent", by: "dispatcher", patch: { machineId: target?.id ?? null } });
      ctx.queue.emit(moved);
      deps.svc.addComment({ taskId: t.id, author: "system", kind: "service", content: reassignNote(pinned.name, target?.name ?? null) });
    } catch (err) { log(`reassign: move of ${t.id} failed`, err); return false; }
    log(`reassign: ${t.id} left ${pinned.name}, now ${target?.name ?? "local"}`);
    return true;
  }
  /** Is the cloud known to refuse this project's repository for the account that would launch? Read fresh, never cached with the origin. */
  function cloudRefusesProject(projectId: string): boolean {
    try { return deps.cloudRefusesProject?.(projectId) ?? false; } catch { return false; }
  }
  function isRemoteTask(task: Task): boolean {
    if (!task.machineId) return false;
    let localMachine: string | null = null;
    let address: string | null = null;
    try { localMachine = deps.node?.localMachineId?.() ?? null; } catch { /* Treat an unknown local id conservatively. */ }
    try { address = deps.node?.baseUrlOf(task.machineId) ?? null; } catch { /* Same: no address, no exemption. */ }
    return localMachine !== null && task.machineId !== localMachine && !!address;
  }
  function beginOverflowRound(projectId: string): number {
    const n = (overflowRounds.get(projectId) ?? 0) + 1;
    overflowRounds.set(projectId, n);
    return n;
  }
  function overflowOriginOf(projectId: string): { ok: boolean; github: boolean } {
    const known = overflowOrigin.get(projectId);
    if (known && clock() - known.at < 10 * 60_000) return known;
    const node = deps.node;
    if (node && !overflowOriginPending.has(projectId)) {
      overflowOriginPending.add(projectId);
      Promise.resolve()
        .then(() => node.originUrlOf(projectId))
        .then(async (origin) => {
          const github = !!origin && !!(await Promise.resolve(deps.githubOriginOf?.(projectId)).catch(() => false));
          overflowOrigin.set(projectId, { ok: !!origin, github, at: clock() });
        })
        .catch(() => { overflowOrigin.set(projectId, { ok: false, github: false, at: clock() }); })
        .finally(() => { overflowOriginPending.delete(projectId); });
    }
    return known ?? { ok: false, github: false };
  }
  /**
   * `true` only before this project's origin has EVER resolved (the lookup
   * `overflowOriginOf` just kicked off is still in flight). SURFACED 2026-11-13:
   * a fresh server's first dispatch tick for a project reads `origin.ok` as
   * `false` while that lookup is pending, which is "unknown", not "no origin" -
   * and a card that would otherwise move to a free node/cloud seat fell
   * through to the Mac instead, on the one tick that mattered, because nothing
   * told the caller the difference. Used to make THAT card wait one round for
   * the answer instead of starting locally on a guess.
   */
  function overflowOriginUnresolved(projectId: string): boolean {
    // `overflowOriginOf` is what actually KICKS OFF the lookup (its early
    // return otherwise never runs when a card takes the deferral below
    // instead of reaching `overflowCardToFreeSeat`, which is the only other caller):
    // called here for that side effect too, not only to read the cache.
    overflowOriginOf(projectId);
    return !overflowOrigin.has(projectId);
  }
  /** Is there a seat on some OTHER online machine right now, origin aside -
   *  cheap enough to ask before deciding whether a cold origin cache is worth
   *  waiting out. */
  function anyOverflowSeatElsewhere(localId: string | null, skipMachineIds?: readonly string[] | null): boolean {
    if (!deps.overflowMachines) return false;
    let machines: OverflowMachine[] = [];
    try { machines = deps.overflowMachines(); } catch { return false; }
    return machines.some((m) => m.id !== localId && !skipMachineIds?.includes(m.id) && m.online && machineLoad(m.id) < effectiveSlots(m));
  }
  function overflowBranchReady(t: Task): boolean | null {
    // A recorded branch that exists nowhere (the working tree is gone and it
    // never reached origin) must not hold the card for ever: the next candidate
    // (`priorBranch`) carries, and with none left the card goes as it is.
    const branch = carriedBranch(t, phantomBranches.get(t.id));
    if (!branch) return true;
    const ensure = deps.node?.ensureBranchOnOrigin;
    // No way to push: the card cannot carry its branch, so it does not leave.
    if (!ensure) return false;
    const known = overflowBranch.get(t.id);
    if (known && known.branch === branch && clock() - known.at < 60_000) return known.ok;
    if (!overflowBranchPending.has(t.id)) {
      overflowBranchPending.add(t.id);
      Promise.resolve()
        .then(() => ensure({ projectId: t.projectId, branch }))
        .then((r) => {
          if (!r.ok && r.reason === BRANCH_NOWHERE_REASON) {
            const set = phantomBranches.get(t.id) ?? new Set<string>();
            set.add(branch);
            phantomBranches.set(t.id, set);
            overflowBranch.delete(t.id);
            log(`overflow: ${t.id} names ${branch}, which exists nowhere: falling back to the next branch it carries`);
            return;
          }
          overflowBranch.set(t.id, { branch, ok: r.ok, reason: r.ok ? "" : r.reason, at: clock() });
          if (!r.ok) log(`overflow: ${t.id} stays, its branch ${branch} cannot reach origin: ${r.reason}`);
        })
        .catch((err) => { overflowBranch.set(t.id, { branch, ok: false, reason: String(err), at: clock() }); })
        .finally(() => { overflowBranchPending.delete(t.id); });
    }
    return null;
  }
  /**
   * The cards a machine is carrying right now: every live card that names it
   * (in Todo or in progress), not only the runs alive in this process. A PC
   * that does not answer, or sleeps, sends its cards back to the queue with a
   * deferral (`deferForSilentNode`): counted by live runs it read as empty and
   * took six cards on two slots, and each wake-up only added more.
   */
  function machineLoad(machineId: string): number {
    let n = 0;
    try { n = deps.svc.countOnMachine(machineId); } catch { n = Number.POSITIVE_INFINITY; }
    const prefix = `node:${machineId}:`;
    let live = 0;
    for (const slot of inFlight.values()) {
      if (slot.node?.machineId === machineId || slot.sessionKey.startsWith(prefix)) live += 1;
    }
    return Math.max(n, live);
  }
  /** The memory floor held this card in this round. */
  function markMemoryHeld(t: Task, round: number): void {
    memoryHeldCards.set(t.id, { projectId: t.projectId, round });
  }
  /** A card that leaves Todo (or comes back to it) is no longer a held one. */
  function forgetOverflowClock(taskId: string): void {
    memoryHeldCards.delete(taskId);
    overflowBranch.delete(taskId);
    phantomBranches.delete(taskId);
  }
  /** Boards that will not tick this pass hold nothing by memory: their records go. */
  function pruneOverflowClocksOutside(ticking: ReadonlySet<string>): void {
    for (const [id, e] of [...memoryHeldCards]) if (!ticking.has(e.projectId)) forgetOverflowClock(id);
  }
  /** End of a round on `projectId`: a card this round did not mark held loses its record. */
  function pruneOverflowClocks(projectId: string, round: number): void {
    for (const [id, e] of [...memoryHeldCards]) {
      if (e.projectId === projectId && e.round !== round) memoryHeldCards.delete(id);
    }
    for (const id of [...overflowBranch.keys()]) if (!memoryHeldCards.has(id)) overflowBranch.delete(id);
  }
  /**
   * THE OVERFLOW'S MOVE for one local card: as soon as a machine has a free
   * seat for it (`pickOverflowMachine`) the card goes there, whatever this
   * Mac's memory floor is doing. `true` = the card now runs elsewhere, and the
   * caller sends it down the remote lane in this same round. `round.no` is the
   * board's round, `round.moved` its moves so far.
   */
  function overflowCardToFreeSeat(
    t: Task,
    settings: { dispatchOverflow?: boolean; dispatchStayLocal?: boolean; dispatchModel?: string | null },
    round: { no: number; moved: number },
  ): boolean {
    if (!deps.overflowMachines || !deps.node) return false;
    let localId: string | null = null;
    try { localId = deps.node.localMachineId?.() ?? null; } catch { /* unknown: no move */ }
    // A delegated card's authority names THIS machine (`policy.machineId`):
    // moved, it would be parked over there as no longer valid.
    const delegated = delegatedPolicy(t) !== undefined;
    if (!localId || !overflowEligible({ ...t, delegated, description: t.description ?? t.descriptionPreview }, settings, localId)) { memoryHeldCards.delete(t.id); return false; }
    // Asked from the first round that sees the card, so the answer is in by the time it matters.
    const origin = overflowOriginOf(t.projectId);
    if (!origin.ok) return false;
    if (round.moved >= OVERFLOW_MAX_PER_ROUND) return false;
    // Its own branch reaches origin first; `null` = the push is under way.
    if (overflowBranchReady(t) !== true) return false;
    let machines: OverflowMachine[] = [];
    try { machines = deps.overflowMachines().filter((m) => m.id !== localId && !t.overflowSkipMachines?.includes(m.id)); } catch (err) { log("overflow: machine list failed", err); return false; }
    let cloudCredit = true;
    try { cloudCredit = deps.cloudCredit?.() ?? (!providerHold() && !providerHold(Date.now(), CLOUD_HOLD_KEY)); } catch { cloudCredit = false; }
    const target = pickOverflowMachine(machines, {
      cloudCredit,
      githubOrigin: origin.github && !cloudRefusesProject(t.projectId),
      // The model the run would use: the card's, else the board's (`auto` = no choice).
      model: t.model ?? (settings.dispatchModel && settings.dispatchModel !== "auto" ? settings.dispatchModel : null),
      // Read after this round's own moves: they are written before the next card is asked.
      load: machineLoad,
      wakeBlocked: nodeBlocked,
    });
    if (!target) return false;
    let moved: Task | null = null;
    try { moved = deps.svc.overflowToMachine({ taskId: t.id, machineId: target.id, localMachineId: localId }); }
    catch (err) { log(`overflow: move of ${t.id} failed`, err); return false; }
    if (!moved) return false;
    round.moved += 1;
    memoryHeldCards.delete(t.id);
    overflowBranch.delete(t.id);
    floorBlockSent.delete(t.id);
    log(`overflow: ${t.id} moved to ${target.name} (${target.kind}), a free seat there`);
    ctx.queue.emit(moved);
    try {
      deps.svc.addComment({
        taskId: t.id,
        author: "system",
        kind: "service",
        content: overflowNoteImmediate(target.name),
      });
    } catch { /* the move stands without its line */ }
    return true;
  }
  return { anyOverflowSeatElsewhere, beginOverflowRound, forgetOverflowClock, isRemoteTask, machineLoad, markMemoryHeld, overflowCardToFreeSeat, overflowOriginUnresolved, pinnedMachineDrained, pinnedMachineFull, pruneOverflowClocks, pruneOverflowClocksOutside, reassignFromForbidden };
}
