/**
 * task-dispatcher.ts — the side-effect layer that turns a "drag into todo" into
 * a real headless agent turn, scoped to that one task, in its own chat tab.
 *
 * The pure FSM + persistence lives in `tasks.ts` (createTaskService); this file
 * is the ONLY place that starts processes, so it stays out of the pure service.
 * Everything it touches — the task store, topic creation, worktree creation, the
 * turn runtime — is injected (see DispatcherDeps) so the orchestration is
 * unit-testable with fakes and the risky real wiring is assembled once in
 * server.ts.
 *
 * Guardrails (Fable review, top-severity first):
 *  - auto_dispatch is OFF by default per board → nothing launches until enabled.
 *  - grace-debounce on the →todo signal: a quick drag-through (todo→elsewhere)
 *    never spawns; only a task that SITS in todo past the grace window claims.
 *  - concurrency cap + retry cap live in the atomic claim (tasks.ts), so every
 *    trigger (drag hook, poll, turn-end) converges on one race-free CAS.
 *  - worktree isolation by default: the agent works a git worktree, never the
 *    live repo next to the human's WIP. If a worktree can't be made and the user
 *    hasn't explicitly opted into in-place, the task is parked with an error
 *    instead of clobbering the repo.
 *  - a passive stall detector, not a wall-clock kill, cuts a turn: silence past
 *    `dispatchIdleMin` asks a cheap judge first, and only a "stuck" verdict
 *    recycles it (see `server/lib/stall-detector.ts`). Turn-end reconciliation
 *    requeues (bounded by the retry cap) or parks a task that ended without
 *    reaching `review`.
 */

import { isNodeSessionKey } from "./task-dispatcher-remote-node";
import { effectiveSlots, type OverflowMachine } from "./dispatch-overflow";
import type { DispatcherDeps, TaskDispatcher } from "./task-dispatcher-types";
import { summarizeToolInput, parkedEdgeEvent } from "./task-dispatcher-support";
import { createDispatcherCore } from "./task-dispatcher-core";
import { createAdmission } from "./task-dispatcher-admission";
import { createProviderHold } from "./task-dispatcher-hold";
import { createRunTracking } from "./task-dispatcher-runs";
import { createOverflow } from "./task-dispatcher-overflow";
import { createQueueSignals } from "./task-dispatcher-queue";
import { createUsageLedger } from "./task-dispatcher-usage";
import { createKickoff } from "./task-dispatcher-kickoff";
import { createLaunch } from "./task-dispatcher-launch";
import { createFanOut } from "./task-dispatcher-fanout";
import { createTurnEnd } from "./task-dispatcher-turn-end";
import { createResume } from "./task-dispatcher-resume";
import { createTick } from "./task-dispatcher-tick";
import { createClaim } from "./task-dispatcher-claim";
import { createReconcile } from "./task-dispatcher-reconcile";
import { createBoardEvents } from "./task-dispatcher-events";
import type { DispatcherCtx } from "./task-dispatcher-context";
export type { DispatcherDeps, TaskDispatcher };
export { summarizeToolInput, parkedEdgeEvent };

export function createTaskDispatcher(deps: DispatcherDeps): TaskDispatcher {
  const ctx = {} as DispatcherCtx;
  ctx.core = createDispatcherCore(deps);
  ctx.admission = createAdmission(ctx);
  ctx.hold = createProviderHold(ctx);
  ctx.runs = createRunTracking(ctx);
  ctx.overflow = createOverflow(ctx);
  ctx.queue = createQueueSignals(ctx);
  ctx.usage = createUsageLedger(ctx);
  ctx.kickoff = createKickoff(ctx);
  ctx.launch = createLaunch(ctx);
  ctx.fanout = createFanOut(ctx);
  ctx.turnEnd = createTurnEnd(ctx);
  ctx.resume = createResume(ctx);
  ctx.tick = createTick(ctx);
  ctx.claim = createClaim(ctx);
  ctx.reconcile = createReconcile(ctx);
  ctx.events = createBoardEvents(ctx);
  const { admissionCountingSince, inFlight, log, shared } = ctx.core;


  return {
    taskForSession: (...args) => ctx.runs.taskWaitingOnSession(...args),
    sessionsInFlight: () => [...inFlight.values()].map((slot) => slot.sessionKey).filter((sk): sk is string => typeof sk === "string" && !!sk),
    tick: (...args) => ctx.tick.tick(...args), onEnterTodo: (...args) => ctx.events.onEnterTodo(...args), onLeaveTodo: (...args) => ctx.events.onLeaveTodo(...args), deferWait: (...args) => ctx.events.deferWait(...args), onBlockerDone: (...args) => ctx.events.onBlockerDone(...args), resume: (...args) => ctx.resume.resume(...args), reconcile: (...args) => ctx.reconcile.reconcile(...args), markInterrupted: (...args) => ctx.events.markInterrupted(...args),
    revokeDelegatedCapability: (...args) => ctx.events.revokeDelegatedCapability(...args), shutdown: (...args) => ctx.events.shutdown(...args), nightStatus: (...args) => ctx.events.nightStatus(...args), admissionPreview: (...args) => ctx.admission.admissionPreview(...args), childAdmissionPreview: (...args) => ctx.admission.childAdmissionPreview(...args), memoryQueueSnapshot: ctx.queue.memoryQueueSnapshot, dispatchWork: (...args) => ctx.queue.dispatchWork(...args),
    sampleCardWeight: (treeGB) => ctx.admission.cardWeights.sample(treeGB, [...inFlight].filter(([, slot]) => !slot.node && !isNodeSessionKey(slot.sessionKey))
      .flatMap(([taskId]) => { try { const projectId = deps.svc.get(taskId)?.task.projectId; return projectId ? [{ taskId, projectId }] : []; } catch { return []; } })),
    startAnyway: ctx.queue.manualMemoryStart.startAnyway,
    // The episode IN FLIGHT is added at read time, not on every tick: a
    // counter that only grows when an episode closes would read zero exactly
    // while the queue is stuck, which is the one moment anyone looks at it.
    admissionHolds: () => ({
      episodes: shared.admissionHoldEpisodes,
      // UP TO THE LAST LOOK, never up to now. The floor is only consulted while
      // the queue is being worked: auto-dispatch off, a paused board, a drain
      // or a heavy job in flight all return before it is read
      // (`task-dispatcher.ts` early exits in `tick`). Charging wall-clock time
      // to the open episode reported 460 s of "floor holding the queue" while
      // the floor was free and the queue was simply switched off - measured on
      // a probe, 30 GB available throughout.
      heldMs: shared.admissionHeldMs + (shared.admissionHoldSince === null ? 0 : Math.max(0, shared.admissionLastSeenAt - shared.admissionHoldSince)),
      holding: shared.admissionHoldSince !== null,
      // WHEN WE LAST LOOKED, which is what tells a live stop from an abandoned
      // one: `holding: true` with an old `lastSeenAt` means "the queue was held
      // when we stopped watching", not "it is held now".
      lastSeenAt: new Date(shared.admissionLastSeenAt).toISOString(),
      since: new Date(admissionCountingSince).toISOString(),
    }),
    isInFlight: (id) => inFlight.has(id),
    reassignFromForbidden: (task, settings) => ctx.overflow.reassignFromForbidden(task, settings),
    emitTask: (task) => ctx.queue.emit(task),
    // THE REMOTE LANE DOES NOT SPEND THIS MACHINE'S CAP (KANBAN-76): a card
    // running on a node costs no process, no worktree and no CPU here, and the
    // cap exists to protect exactly those. `running` in
    // GET /api/system/dispatch-capacity reads this number, so both sides of the
    // requirement come from one predicate - the same `localTurns()` the memory
    // floor reads, so "our work is on the machine" and "running" cannot drift
    // apart into two different counts of the same agents.
    busyCount: (...args) => ctx.admission.localTurns(...args),
    // ...but `busyIds` stays HONEST about what is in flight: it answers "what
    // is a restart waiting for", and a remote run is something this process is
    // holding a handle on. Hiding it there would make a drain believe the board
    // is idle while a poll is still mirroring a card.
    busyIds: () => [...inFlight.keys()],
    nodeStatus: () => {
      let machines: OverflowMachine[] = [];
      try { machines = deps.overflowMachines?.() ?? []; } catch { machines = []; }
      return machines.map((m) => ({
        id: m.id,
        name: m.name,
        kind: m.kind,
        online: m.online,
        slots: effectiveSlots(m),
        used: ctx.overflow.machineLoad(m.id),
      }));
    },
    busySessionKeys: () => [...inFlight.values()].map((slot) => slot.sessionKey).filter((key) => key !== ""),
    // The same filter as `busyCount`: a run riding on a node holds no turn on
    // this machine, so it is not what a restart here waits for.
    busyTurns: () => [...inFlight.entries()]
      .filter(([, slot]) => !isNodeSessionKey(slot.sessionKey))
      .map(([taskId, slot]) => ({ taskId, sessionKey: slot.sessionKey })),
    drain: (reason) => {
      if (shared.draining !== reason) log(`drain: nessun turno nuovo fino al riavvio (${reason}); ${inFlight.size} in volo`);
      shared.draining = reason;
    },
    undrain: (reason) => {
      if (!shared.draining) return;
      log(`drain tolto (${reason}): il riavvio aspetta solo chat, che non hanno un limite nostro; le card ripartono, la porta si richiude appena a trattenere restano solo card`);
      shared.draining = null;
    },
  };}
