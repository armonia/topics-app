/**
 * task-dispatcher-remote-node.ts — THE REMOTE LANE, whole, in one file.
 *
 * A card whose `machine_id` names a paired node does not run here: it runs
 * THERE, and what stays on this machine is a handle on that run (KANBAN-76,
 * KANBAN-77). That lane has its own launch, its own liveness rule, its own
 * burial and its own delivery, and none of them share a line with the local
 * ones — which is exactly why they were extracted: inside `task-dispatcher.ts`
 * they read as five unrelated branches scattered across five thousand lines.
 *
 * NOTHING HERE CHANGES BEHAVIOUR. The dispatcher keeps the decisions that are
 * its own (when to launch, when to sweep, when to reconcile) and calls this
 * lane at the five points where the remote answer differs from the local one:
 * `remoteLaunch`, `sweepVerdict`, `buryRun`, `poll`, `queueAfterRestart`.
 *
 * Everything it touches is injected through `RemoteNodeHost` — the same
 * discipline as `DispatcherDeps`, and for the same reason: the lane is tested
 * with a fake node, a fake clock and no repository at all
 * (`task-dispatcher-remote-node.test.ts`).
 */
import { NODE_UNREACHABLE_ERROR } from "../../shared/board";
import type { Task, TaskService } from "./tasks";
import type { BundleResult, CreateRunBody, NodeRunReport } from "./node-client";
import type { PlantBranchInput, PlantBranchResult } from "./node-branch-plant";
import type { OutboundMessage } from "../../shared/ws-outbound";

/**
 * THE REMOTE LANE'S HOST CAPABILITY: how this board talks to a paired node, and
 * how a branch born there is planted here (KANBAN-76, KANBAN-77).
 *
 * Optional on `DispatcherDeps` like every other host capability: absent means no
 * card can run anywhere but here, which is the historical behaviour and what
 * every test harness that does not care about nodes keeps getting.
 *
 * The four calls are `node-client.ts` verbatim, the three lookups come from
 * the machine store plus the token file, and `plantBranch` is the ONLY seam
 * that touches git: keeping the subprocess out of this file is what lets the
 * lane be tested without a repository.
 */
export interface NodeDeps {
  createRun: (input: { baseUrl: string; token: string; body: CreateRunBody }) => Promise<{ runId: string }>;
  readRun: (input: { baseUrl: string; token: string; runId: string }) => Promise<NodeRunReport>;
  fetchBundle: (input: { baseUrl: string; token: string; runId: string }) => Promise<BundleResult>;
  cancelRun: (input: { baseUrl: string; token: string; runId: string }) => Promise<void>;
  /** Where that machine answers, `null` when it is not a paired node. */
  baseUrlOf: (machineId: string) => string | null;
  /** The device token this machine holds for it, `null` when never paired. */
  tokenOf: (machineId: string) => string | null;
  /** Its name, for the notes a person reads. `null` falls back to the id. */
  nameOf: (machineId: string) => string | null;
  /**
   * The id of THIS machine's own row, when it has one.
   *
   * A card may legitimately name the local machine: `machines` lists it like
   * any other and the board lets a person pick it. That card is a LOCAL card
   * (the default said out loud), and without this lookup the remote lane
   * would wait forever for a node that is us, on a row whose `baseUrl` is
   * null by construction.
   */
  localMachineId?: () => string | null;
  /** The git remote the node resolves its own project by (never a path: the ids differ). */
  originUrlOf: (projectId: string) => Promise<string | null>;
  plantBranch: (input: PlantBranchInput) => Promise<PlantBranchResult>;
}

/**
 * The remote half of a slot. It lives INSIDE `inFlight` so that a burial
 * (which deletes the slot) also forgets the failed-poll counter: a counter
 * that outlived its run would bury the next one early.
 */
export interface NodeSlot {
  machineId: string;
  baseUrl: string;
  token: string;
  runId: string;
  /** Consecutive failed polls. Reset to 0 by any answer (KANBAN-77). */
  fails: number;
  /** Node comment ids already mirrored (or seeded by the first poll). */
  seen: Set<string>;
  /**
   * The first poll SEEDS the anchors instead of writing them: the only
   * comment the node has at that point is its own "mirrored from <origin>"
   * note, and mirroring that back onto the card it came from is noise.
   */
  primed: boolean;
}

/**
 * A remote slot's session key: `node:<machineId>:<runId>`.
 *
 * One predicate, exported, because three places ask the same question (the
 * cap, the liveness sweep, the test) and three copies of a `startsWith` are
 * three chances for one of them to drift.
 */
export function nodeSessionKey(machineId: string, runId: string): string {
  return `node:${machineId}:${runId}`;
}

export function isNodeSessionKey(sessionKey: string): boolean {
  return sessionKey.startsWith("node:");
}

/**
 * How many CONSECUTIVE failed polls bury a remote run (KANBAN-77).
 *
 * Counted in polls and never in elapsed time, which is the whole requirement: a
 * closed laptop produces no polls at all, so twenty minutes of silence must
 * bury nothing. A clock-based rule would bury every remote card the moment the
 * lid opens, which is the self-inflicted death `sweepDeadTurns` already keeps
 * its hysteresis against.
 */
export const NODE_DEAD_POLLS = 30;

/** How long a card waits before trying a silent node again. */
const NODE_RETRY_MINUTES = 5;

// The three chips this lane writes. Plain literals in the dispatcher too: they
// are the same three strings the board renders, not a shared enum.
const CHIP_WORKING = "working";
const CHIP_BLOCKED = "blocked";
const CHIP_WAITING = "waiting";

/**
 * The part of the dispatcher's `RunSlot` this lane may look at: the run's
 * identity, and its remote half when it has one. The dispatcher's own fields
 * (session key, liveness hysteresis) mean nothing on another machine.
 */
export interface RemoteRunSlot {
  runId: number;
  node?: NodeSlot;
}

/**
 * What the lane borrows from the dispatcher. Every name here is the dispatcher's
 * own function, passed in unchanged: this file decides WHAT the remote lane
 * does, never how a slot is claimed or a task released.
 */
export interface RemoteNodeHost {
  /** The host capability itself. Absent = this server cannot talk to nodes. */
  client?: NodeDeps;
  svc: TaskService;
  broadcast: (message: OutboundMessage) => void;
  captureDelivery?: (taskId: string) => Promise<boolean>;
  log: (msg: string, err?: unknown) => void;
  /** Broadcast the updated task so live boards move the chip. */
  emit: (task: Task) => void;
  /** The dispatcher's in-flight slots, keyed by taskId. */
  inFlight: Map<string, RemoteRunSlot>;
  beginRun: (taskId: string, sessionKey: string) => number;
  endRun: (taskId: string, runId: number) => void;
  ownsRun: (taskId: string, runId: number) => boolean;
  bindRunSession: (taskId: string, runId: number, sessionKey: string) => void;
  releaseAndEmit: (
    args: Parameters<TaskService["release"]>[0],
    opts?: { announce?: boolean },
  ) => Task;
  deferWait: (taskId: string, reason: string, minutes?: number) => Task;
}

export interface RemoteNodeLane {
  /**
   * The card names another machine: this lane takes it over and `launch` must
   * await what comes back and return. `null` = a local card, nothing happened.
   *
   * The decision is SYNCHRONOUS on purpose. `tick` fires `launch` without
   * awaiting it, so an `await` placed before `beginRun` would postpone the slot
   * of every LOCAL card by a microtask - long enough for a caller that has just
   * awaited `tick` to see no turn at all.
   */
  remoteLaunch(taskId: string, settings: { effort: string; model?: string }): Promise<void> | null;
  /** How the liveness sweep must judge this slot. `local` = not a remote slot. */
  sweepVerdict(slot: RemoteRunSlot): "local" | "wait" | "bury";
  /** The burial of a remote run, in place of the local turn accounting. */
  buryRun(taskId: string, node: NodeSlot): void;
  /** One poll per remote slot: the whole life signal of a remote run. */
  poll(): Promise<void>;
  /**
   * The restart orphan pass, for a card that names a node: `true` requeued,
   * `false` tried and failed, `null` not this lane's card.
   */
  queueAfterRestart(task: Task): boolean | null;
}

export function createRemoteNodeLane(host: RemoteNodeHost): RemoteNodeLane {
  const { svc, log, emit, inFlight, releaseAndEmit } = host;

  /**
   * The LAST run id created on a node for a task, kept per task.
   *
   * Deliberately NOT in `inFlight`: a buried run leaves `inFlight`, and it is
   * exactly then that this id is needed. A run this board gave up on may still
   * be working on the node, so the next dispatch of the same card cancels it
   * first (KANBAN-77) - without that the card collects two deliveries and two
   * branches.
   */
  const lastNodeRun = new Map<string, string>();

  /** The node's name as a person reads it, with the id as the honest fallback. */
  function nodeName(machineId: string): string {
    try { return host.client?.nameOf(machineId) || machineId; } catch { return machineId; }
  }

  /** The DECLARED reason of a failed node call (`NodeError.reason`), when it carries one. */
  function nodeFailureReason(err: unknown): string | null {
    const r = (err as { reason?: unknown } | null)?.reason;
    return typeof r === "string" ? r : null;
  }

  /**
   * The node did not answer: the card waits HERE, in the queue, and says why.
   * It NEVER falls back to a local turn - that is the whole point of choosing a
   * machine by hand (KANBAN-76).
   *
   * Two writes because no single service call does both. `deferForWait` is the
   * only writer of `dispatch_deferred_until`, and it also refunds the attempt
   * the claim had already spent; `setDispatchState` is what puts the SENTINEL
   * in `dispatch_error`, because `deriveQueueReason` matches a word and not the
   * prose the deferral leaves there.
   */
  function deferForSilentNode(task: Task, why: string): void {
    try {
      const after = host.deferWait(task.id, why, NODE_RETRY_MINUTES);
      // The sentinel goes ONLY on a card that is still waiting in the queue.
      // Past its own cap the wait parks the card and announces the park with
      // its own chip (`waited_out`) and note: overwriting that would hide "the
      // node has been silent for half an hour, decide" behind "in coda".
      if (after.status === "todo") {
        emit(svc.setDispatchState({
          taskId: task.id,
          state: after.dispatchState ?? CHIP_WAITING,
          error: NODE_UNREACHABLE_ERROR,
        }));
      }
    } catch (err) { log(`nodo: rinvio della card ${task.id} non riuscito`, err); }
  }

  /** A card that can never start where it is pointed: parked, with the fix in words. */
  function parkNodeCard(task: Task, reason: string): void {
    try { releaseAndEmit({ taskId: task.id, requeue: false, parkState: CHIP_BLOCKED, reason }); }
    catch (err) { log(`nodo: parcheggio della card ${task.id} non riuscito`, err); }
  }

  /**
   * THE REMOTE LANE: this card runs on a NODE, and the slot it holds here is
   * only a handle on that run (KANBAN-76).
   *
   * There is no promise to await at the end: the run's life belongs to the
   * reconcile poll, which mirrors its state and its comments and, when it
   * reaches review, brings the branch back as a bundle.
   */
  async function launchOnNode(
    task: Task,
    settings: { effort: string; model?: string },
  ): Promise<void> {
    const node = host.client!;
    const machineId = task.machineId!;
    const name = nodeName(machineId);
    const baseUrl = node.baseUrlOf(machineId);
    const token = node.tokenOf(machineId);
    if (!baseUrl || !token) {
      deferForSilentNode(
        task,
        `il nodo «${name}» non risponde` + (baseUrl ? " (nessun accoppiamento valido)" : " (nessun indirizzo noto)"),
      );
      return;
    }
    // The node resolves the project by its git ORIGIN, never by id or path:
    // our project id is a hash of a folder that does not exist over there.
    const originUrl = await Promise.resolve(node.originUrlOf(task.projectId)).catch(() => null);
    if (!originUrl) {
      parkNodeCard(
        task,
        `Questa card è assegnata al nodo «${name}», ma il progetto non ha un remoto git «origin»: è da lì che il nodo ` +
          "riconosce il repository. Aggiungi l'origin, oppure togli la macchina dalla card.",
      );
      return;
    }
    const runNo = host.beginRun(task.id, "");
    try {
      // THE OLD RUN DIES BEFORE A NEW ONE IS BORN. A run this board buried may
      // still be working over there, and two live runs on one card means two
      // deliveries and two branches (KANBAN-77).
      const previous = lastNodeRun.get(task.id);
      if (previous) {
        try { await node.cancelRun({ baseUrl, token, runId: previous }); }
        catch (err) { log(`nodo: la corsa ${previous} non si è cancellata`, err); }
        lastNodeRun.delete(task.id);
      }
      const { runId } = await node.createRun({
        baseUrl,
        token,
        body: {
          originTaskId: task.id,
          originUrl,
          text: task.text,
          description: task.description ?? "",
          model: task.model ?? settings.model ?? null,
          effort: settings.effort && settings.effort !== "auto" ? settings.effort : null,
        },
      });
      lastNodeRun.set(task.id, runId);
      if (!host.ownsRun(task.id, runNo)) {
        // Superseded while the node was answering: the run we just created has
        // no owner here, and leaving it alive is the two-deliveries defect.
        try { await node.cancelRun({ baseUrl, token, runId }); } catch { /* best-effort */ }
        return;
      }
      host.bindRunSession(task.id, runNo, nodeSessionKey(machineId, runId));
      const slot = inFlight.get(task.id);
      if (slot) slot.node = { machineId, baseUrl, token, runId, fails: 0, seen: new Set(), primed: false };
      emit(svc.setDispatchState({ taskId: task.id, state: CHIP_WORKING }));
      try {
        svc.addComment({
          taskId: task.id, author: "system", kind: "service",
          content:
            `Questa card gira sul nodo «${name}» (corsa \`${runId.slice(0, 8)}\`). ` +
            "Stato e commenti di servizio arrivano qui a ogni giro; il ramo torna a consegna fatta.",
        });
      } catch { /* best-effort: the note never blocks the dispatch */ }
    } catch (err) {
      host.endRun(task.id, runNo);
      if (nodeFailureReason(err) === "no_such_repo") {
        parkNodeCard(
          task,
          `Il nodo «${name}» non ha nessun progetto con il remoto \`${originUrl}\`: clonalo là, oppure togli la macchina ` +
            "dalla card. Nessun progetto è stato creato sul nodo.",
        );
        return;
      }
      log(`nodo: creazione della corsa per ${task.id} fallita`, err);
      deferForSilentNode(task, `il nodo «${name}» non risponde`);
    }
  }

  /**
   * THE REMOTE LANE COMES FIRST, and nothing under it may run for a card that
   * names a node: no worktree, no topic, no turn (KANBAN-76). It is asked
   * before `beginRun` because the remote slot keeps its handle after `launch`
   * returns, and the `finally` there would free it under the poll.
   *
   * Not `async`: see `RemoteNodeLane.remoteLaunch`. A local card must come out
   * of here without ever yielding.
   */
  function remoteLaunch(
    taskId: string,
    settings: { effort: string; model?: string },
  ): Promise<void> | null {
    const claimedTask = svc.get(taskId)?.task;
    const localMachine = (() => { try { return host.client?.localMachineId?.() ?? null; } catch { return null; } })();
    if (!claimedTask?.machineId || claimedTask.machineId === localMachine) return null;
    if (!host.client) {
      parkNodeCard(
        claimedTask,
        "Questa card è assegnata a un'altra macchina, ma questo server non sa parlare con i nodi: " +
          "togli la macchina dalla card per farla girare qui.",
      );
      return Promise.resolve();
    }
    return launchOnNode(claimedTask, settings);
  }

  /**
   * The opening of the note a buried REMOTE run leaves, and the slot it lives
   * in. Same discipline as `DEAD_SESSION_NOTE`: the sentence describes a
   * condition, not an event worth counting, so a second burial replaces it
   * instead of adding a paragraph.
   */
  const NODE_BURIED_NOTE = "La corsa sul nodo non risponde più";

  /**
   * A remote run nobody can reach any more (KANBAN-77).
   *
   * It does NOT take the `onTurnEnd` road. That road, for a card with no topic
   * bound (and a remote card never has one), ends in a system delivery or a
   * park in backlog. What KANBAN-77 asks for is the orphan treatment of
   * KANBAN-10: back to `todo`, attempt REFUNDED, one note.
   *
   * The run id stays in `lastNodeRun` on purpose: a run we gave up on is not a
   * run that STOPPED, so the next dispatch of this card cancels it first.
   */
  function buryRun(taskId: string, node: NodeSlot): void {
    const name = nodeName(node.machineId);
    log(`nodo: corsa ${node.runId} su «${name}» sepolta dopo ${NODE_DEAD_POLLS} giri falliti di fila (task ${taskId})`);
    try {
      svc.addComment({
        taskId, author: "system", kind: "service",
        replaces: NODE_BURIED_NOTE,
        content:
          `${NODE_BURIED_NOTE}: «${name}» non ha risposto a ${NODE_DEAD_POLLS} giri consecutivi. ` +
          "Rimetto la card in coda col tentativo rimborsato. La corsa di là potrebbe essere ancora viva: " +
          "viene cancellata prima che ne parta una nuova.",
      });
    } catch { /* dedupe/best-effort */ }
    // No `reason` here: the note above is already in the thread, and `release`
    // would write it a second time as a comment AND into `dispatch_error`.
    try { releaseAndEmit({ taskId, requeue: true, rollbackAttempt: true }); }
    catch (err) { log(`nodo: la card ${taskId} non è tornata in coda dopo la sepoltura`, err); }
  }

  /**
   * A REMOTE slot is judged by its FAILED POLLS, never by the local probe:
   * `isTurnAlive` knows nothing about a session on another machine and would
   * answer "dead" for every one of them, burying a healthy run in two sweeps.
   * And never by elapsed time: a closed laptop produces no polls at all, so
   * silence alone buries nothing (KANBAN-77).
   */
  function sweepVerdict(slot: RemoteRunSlot): "local" | "wait" | "bury" {
    if (!slot.node) return "local";
    return slot.node.fails >= NODE_DEAD_POLLS ? "bury" : "wait";
  }

  /** The node's diffstat, when it measured one. `null` is "not measured", never zero. */
  function nodeStat(raw: unknown): { filesChanged: number; insertions: number; deletions: number } | null {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as { filesChanged?: unknown; insertions?: unknown; deletions?: unknown };
    if (typeof o.filesChanged !== "number" || typeof o.insertions !== "number" || typeof o.deletions !== "number") return null;
    return { filesChanged: o.filesChanged, insertions: o.insertions, deletions: o.deletions };
  }

  /**
   * The node's state and its service comments, copied onto the local card
   * (KANBAN-76).
   *
   * DEDUPE IS BY ANCHOR, not by text: every mirrored row carries the id of the
   * comment on the node in `task_comments.message_id` (KANBAN-72), so a comment
   * that comes back in the next report is recognised as one already written.
   * The anchor is read from the CARD and not only from memory, which is what
   * makes the rule survive a restart of this process.
   */
  function mirrorNodeReport(taskId: string, node: NodeSlot, report: NodeRunReport): void {
    const got = svc.get(taskId);
    if (!got) return;
    if (report.dispatchState && report.dispatchState !== got.task.dispatchState) {
      try { emit(svc.setDispatchState({ taskId, state: report.dispatchState })); }
      catch (err) { log(`nodo: chip non specchiato su ${taskId}`, err); }
    }
    if (!node.primed) {
      // The FIRST report carries what the node wrote before anybody polled:
      // its own "mirrored from <origin>" note, which is this board's own
      // dispatch coming back. Writing it here would put "mirrored from us" on
      // the card it came from.
      node.primed = true;
      for (const c of report.comments) if (c.id) node.seen.add(c.id);
      return;
    }
    const anchored = new Set<string>();
    for (const c of got.comments ?? []) if (c.messageId) anchored.add(c.messageId);
    for (const c of report.comments) {
      if (!c.id || node.seen.has(c.id) || anchored.has(c.id)) continue;
      try {
        svc.addComment({
          taskId,
          author: c.author === "agent" ? "agent" : "system",
          // Only the thread: the node's CHAT never travels here, and the report
          // carries none by construction (`/api/nodes/runs/:id` returns task
          // comments and nothing else).
          kind: c.kind === "delivery" ? "delivery" : "service",
          content: c.content,
          messageId: c.id,
        });
        node.seen.add(c.id);
      } catch (err) { log(`nodo: commento ${c.id} non specchiato su ${taskId}`, err); }
    }
  }

  /**
   * The node's card reached review: the BRANCH comes back with it (KANBAN-76).
   *
   * A git bundle over the channel that is already authenticated, verified and
   * planted here as `refs/heads/<branch>`; from that point on the landing is
   * the local one, unchanged. No push, no shared remote. When the branch cannot
   * be planted the card still reaches review, with the reason on it: the work
   * exists on the node and a person has to be able to read what stopped it.
   */
  async function landNodeDelivery(taskId: string, node: NodeSlot, report: NodeRunReport): Promise<void> {
    const client = host.client;
    if (!client) return;
    const name = nodeName(node.machineId);
    // The slot goes first: the run is over on the node, and what follows is
    // bookkeeping this board owes the card, not a run to keep polling.
    inFlight.delete(taskId);
    const task = svc.get(taskId)?.task;
    if (!task) return;
    const branch = report.deliveryBranch;
    let planted: PlantBranchResult = { planted: false, commit: null, reason: "il nodo non ha consegnato nessun ramo" };
    if (branch) {
      let bundle: Uint8Array | null = null;
      let fetchFailed: string | null = null;
      try {
        const got: BundleResult = await client.fetchBundle({ baseUrl: node.baseUrl, token: node.token, runId: node.runId });
        bundle = got.empty ? null : got.bytes;
      } catch (err) {
        fetchFailed = `il bundle non è arrivato dal nodo «${name}»`;
        log(`nodo: bundle della corsa ${node.runId} non scaricato`, err);
      }
      planted = fetchFailed
        ? { planted: false, commit: null, reason: fetchFailed }
        : await client
          .plantBranch({ projectId: task.projectId, branch, baseSha: report.baseSha, bundle })
          .catch((err): PlantBranchResult => {
            log(`nodo: impianto del ramo ${branch} fallito`, err);
            return { planted: false, commit: null, reason: "l'impianto del ramo è fallito su questa macchina" };
          });
      if (planted.planted) {
        try {
          // `recordDelivery` and not `setDeliveryBranch` alone: the commit and
          // the diffstat come from the node, and a card in review with a branch
          // but no commit has nothing for the landing to check.
          svc.recordDelivery({
            taskId,
            branch,
            commit: planted.commit ?? report.deliveryCommit,
            stat: nodeStat(report.stat),
          });
        } catch (err) { log(`nodo: consegna non registrata su ${taskId}`, err); }
        // The same seam the local delivery uses. It writes nothing when the
        // card has no worktree here, which is a remote card by definition:
        // harmless, and it keeps the two lanes on one road.
        if (host.captureDelivery) {
          try { await host.captureDelivery(taskId); } catch { /* never block the delivery on git */ }
        }
      }
    }
    const reason = planted.planted
      ? `Consegnato dal nodo «${name}»: il ramo \`${branch}\` è stato piantato in questo checkout` +
        (planted.commit ? ` su \`${planted.commit.slice(0, 8)}\`.` : ".")
      : `Consegnato dal nodo «${name}», ma il ramo non è arrivato: ${planted.reason ?? "motivo non dichiarato"}.`;
    const nextMove = planted.planted
      ? "Da qui l'atterraggio è quello di sempre: guarda il diff e approva, oppure rimandala indietro."
      : "Il lavoro è sul nodo, non qui: sistema quello che manca e rimanda indietro la card per farla riconsegnare.";
    try {
      const delivered = svc.deliverToReviewBySystem({ taskId, reason, nextMove });
      emit(delivered);
      // Same edge the local system delivery emits: without it the review-ready
      // notification never fires for a card that never passed through the route.
      try {
        host.broadcast({
          type: "task:review-ready",
          projectId: delivered.projectId,
          taskId: delivered.id,
          taskTitle: delivered.text || "Task",
          reason: "system-delivered",
        });
      } catch { /* best-effort */ }
    } catch (err) { log(`nodo: consegna in review non riuscita per ${taskId}`, err); }
  }

  /**
   * ONE POLL PER REMOTE SLOT, every reconcile tick. This is the whole life
   * signal of a remote run: there is no promise to await and no process to
   * probe (KANBAN-76, KANBAN-77).
   */
  async function poll(): Promise<void> {
    const client = host.client;
    if (!client) return;
    for (const [taskId, slot] of [...inFlight]) {
      const node = slot.node;
      if (!node) continue;
      let report: NodeRunReport;
      try {
        report = await client.readRun({ baseUrl: node.baseUrl, token: node.token, runId: node.runId });
      } catch (err) {
        node.fails++;
        log(`nodo: giro fallito per ${taskId} (${node.fails}/${NODE_DEAD_POLLS})`, err);
        continue;
      }
      // In the spirit of `ownsRun`: while this poll was in the air the run may
      // have been buried and the card re-dispatched onto a NEW run. A report
      // carrying a run this dispatcher no longer owns is DROPPED, or the card
      // collects two deliveries (KANBAN-77).
      const still = inFlight.get(taskId);
      if (!still || still.runId !== slot.runId || still.node?.runId !== node.runId) continue;
      node.fails = 0;
      mirrorNodeReport(taskId, node, report);
      if (report.status === "review") await landNodeDelivery(taskId, node, report);
    }
  }

  /**
   * A card that names a NODE is never resumed HERE. The recovery in `reconcile`
   * ends in `resume`, which opens a local topic and a local turn: for a remote
   * card that is the one thing KANBAN-76 forbids. Its slot lived only in
   * memory, so after a restart the honest move is the queue - the tick
   * re-dispatches it to the node, and that dispatch cancels the old run
   * before creating a new one (KANBAN-77).
   */
  function queueAfterRestart(task: Task): boolean | null {
    if (!task.machineId || !host.client) return null;
    try {
      svc.claimInterruption({
        taskId: task.id,
        note:
          "Il server è ripartito mentre questa card girava su un nodo: la rimetto in coda (nessun tentativo consumato). " +
          "Riparte sul nodo, dopo aver cancellato la corsa vecchia.",
      });
      releaseAndEmit({ taskId: task.id, requeue: true, rollbackAttempt: true });
      return true;
    } catch (err) {
      log(`nodo: card ${task.id} non rimessa in coda dopo il riavvio`, err);
      return false;
    }
  }

  return { remoteLaunch, sweepVerdict, buryRun, poll, queueAfterRestart };
}
