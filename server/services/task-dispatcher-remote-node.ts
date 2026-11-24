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
import { isModelUnavailable, MODEL_SKIP_MS } from "./dispatch-overflow";
import { wakeBreaker, hangBreaker } from "./wake-breaker";
import { awaitsHuman } from "../../shared/workflow";
import { NODE_UNREACHABLE_ERROR } from "../../shared/board";
import type { Task, TaskService } from "./tasks";
import { returnEmptyNodeRunToTodo } from "./task-dispatcher-remote-node-empty";
import { isNodeError, type BundleResult, type CreateRunBody, type NodeRunBinding, type NodeRunReport } from "./node-client";
import type { DelegatedRunPolicy } from "../lib/delegated-agent-start";
import type { PlantBranchInput, PlantBranchResult } from "./node-branch-plant";
import type { OutboundMessage } from "../../shared/ws-outbound";
import { CLOUD_HOLD_KEY, parseCloudWeeklyLimit, type CloudWeeklyLimit } from "../lib/cloud-weekly-limit";
import { setProviderHold } from "../lib/provider-hold";
import { carriedBranch, UNPLANTED_DELIVERY_COMMIT } from "./branch-on-origin";
import { defaultLifecycleHooks, type HookOutcome, type LifecycleHookRunner } from "./lifecycle-hooks";
import { nodeRunDescription, withNodeRunLanguage } from "./node-run-brief";
import type { OutputLanguage } from "../../shared/types";

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
  createRun: (input: {
    baseUrl: string;
    token: string;
    body: CreateRunBody;
    delegation?: NodeRunBinding;
  }) => Promise<{ runId: string }>;
  readRun: (input: { baseUrl: string; token: string; runId: string; delegation?: NodeRunBinding }) => Promise<NodeRunReport>;
  fetchBundle: (input: { baseUrl: string; token: string; runId: string; delegation?: NodeRunBinding }) => Promise<BundleResult>;
  cancelRun: (input: { baseUrl: string; token: string; runId: string; delegation?: NodeRunBinding }) => Promise<void>;
  /** Where that machine answers, `null` when it is not a paired node. */
  baseUrlOf: (machineId: string) => string | null;
  /** The device token this machine holds for it, `null` when never paired. */
  tokenOf: (machineId: string) => string | null;
  /** A confined device token, distinct from the legacy owner pairing token. */
  delegatedTokenOf?: (machineId: string, capabilityId: string) => string | null;
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
  /**
   * The identity this checkout signs commits with (`git-identity.ts`'s
   * `repoIdentity`), `null` when none is configured. The node must sign the
   * run's commits with THIS identity, never one of its own: the land (LAND-13)
   * refuses a foreign author. Absent = no gate, the historical behaviour.
   */
  gitIdentityOf?: (projectId: string) => Promise<{ name: string; email: string } | null>;
  /**
   * A lane whose commits are not signed by this identity (the Claude cloud
   * signs its own branch): the gate above does not apply to it. Absent = every
   * lane needs the identity.
   */
  skipsGitIdentity?: (baseUrl: string) => boolean;
  plantBranch: (input: PlantBranchInput) => Promise<PlantBranchResult>;
  /**
   * Makes sure a card's own branch is on origin, pushing it when this checkout
   * is ahead (or origin lacks it). `ok: false` = the branch carries work origin
   * cannot get, and a run started elsewhere would start without it. Absent = no
   * card carries its branch to a node, the historical behaviour.
   */
  ensureBranchOnOrigin?: (input: { projectId: string; branch: string }) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * The card's branch as a git bundle, for a node that cannot reach origin
   * (it answered `branch_unreachable`). `null` = no local branch to send.
   */
  bundleBranch?: (input: { projectId: string; branch: string }) => Promise<Uint8Array | null>;
  /** The checkout of a project on THIS machine: the `cwd` the `node-run` hook starts in. */
  projectPathOf?: (projectId: string) => string | null;
  /**
   * Runs the `node-run` hook before a card is sent to the node (wake the PC,
   * bring its repo up to date). Absent = the shared runner reading `hooks.json`.
   */
  hooks?: LifecycleHookRunner;
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
  delegation?: NodeRunBinding;
  /** A created run whose cancellation was not confirmed must keep its exact id until retry succeeds. */
  cancelPending?: boolean;
  cancelReason?: "audit_binding_failed";
  /** Polls that saw the run in review with no branch and no reason (see `NODE_BRANCH_GRACE_POLLS`). */
  reviewWithoutBranch?: number;
  /** Rounds in a row in which the old mirror of the previous delivery could not be cancelled. */
  retireFails?: number;
  /** Consecutive polls answered with a cloud account error (see `NODE_SETUP_POLLS`). Reset by any answer. */
  setupFails?: number;
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

/**
 * A node that is reachable enough to ACCEPT a run (the hook and `createRun`
 * both answer) but then never answers a single poll of it: a hung process,
 * port open, nothing behind it. Its own breaker, never the shared
 * `wakeBreaker` — that one closes the moment `createRun` succeeds, which a
 * hung node does just as readily as a healthy one, so sharing the map would
 * let every relaunch wipe the very failure it just recorded and the loop
 * would never trip (measured 21/11: burial, instant relaunch, burial again,
 * for hours, on the Windows node, starving every other board behind it).
 * Cleared only by a poll that actually comes back.
 */
export { hangBreaker };
/**
 * How many CONSECUTIVE polls of a LIVE run must answer with a cloud account
 * error (`cloud_setup`) before the card is parked with that cause. Not one: a
 * credential read is a `security` call with a 10 s timeout, and on a loaded Mac
 * (load up to 131 on 12 cores) one of them can fail while the account is fine;
 * parking on it stopped a live cloud run that the next round read again. Not
 * thirty either (`NODE_DEAD_POLLS`): a login really switched to another account
 * answers the same every round, and five minutes of "did not answer" hid it.
 */
export const NODE_SETUP_POLLS = 3;
/**
 * A node that answers but will not drop the old mirror of the previous delivery: after this many
 * rounds the card is parked with the fix in words, because re-queueing it would only be handed the
 * same mirror back for ever.
 */
export const NODE_RETIRE_TRIES = 5;

/**
 * Polls a run may sit in review with no branch, and no reason for it, before the
 * card lands empty. On the node the system delivery writes the status and then
 * the branch, about half a second apart: on 26/10 a poll that fell in between
 * read "review, no branch" and the card landed here empty while the commit sat
 * on the node. A run that really has no branch pays this many ticks.
 */
export const NODE_BRANCH_GRACE_POLLS = 3;

/** How long a card waits before trying a silent node again. */
const NODE_RETRY_MINUTES = 5;
/** The opening of the one note a card leaves when it leaves a blocked node (`deferForSilentNode`). */
const NODE_LEFT_NOTE = "Tolta dal nodo bloccato";
/** "22:25": when a breaker closes, as the card's notes say it. */
const hourLabel = (ms: number): string => new Date(ms).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
/** Longest wait for a node to archive one retired mirror: past it, the next round tries again. */
export const MIRROR_CANCEL_TIMEOUT_MS = 10_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

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
  sessionKey: string;
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
  /** Measure the planted branch's bar and offer the card to the automatic land (fire and forget). */
  measureDelivery?: (taskId: string) => Promise<void>;
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
  deferWait: (taskId: string, reason: string, minutes?: number, source?: "agent" | "machine") => Task;
  delegatedPolicyForTask?: (taskId: string) => DelegatedRunPolicy | null;
  /** The board's effective answer language (`langFor`). Absent = no language block. */
  languageOf?: (projectId: string) => OutputLanguage;
  recordDelegatedPhase?: (input: {
    taskId: string;
    phase: "dispatch" | "cancelled" | "completed" | "failed";
    executionSessionId?: string | null;
    outcome?: string | null;
  }) => boolean | number;
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
  remoteLaunch(taskId: string, settings: { effort: string; model?: string; timeoutMin: number }): Promise<void> | null;
  /** How the liveness sweep must judge this slot. `local` = not a remote slot. */
  sweepVerdict(slot: RemoteRunSlot): "local" | "wait" | "bury";
  /** The burial of a remote run, in place of the local turn accounting. */
  buryRun(taskId: string, node: NodeSlot): void;
  /** One poll per remote slot: the whole life signal of a remote run. */
  poll(): Promise<void>;
  /**
   * The restart orphan pass, for a card that names a node: `true` requeued,
   * `false` left alone (reattached to its still-open run, failed to requeue, or a
   * launch of this process is still on its way to the node), `null` not this
   * lane's card.
   */
  queueAfterRestart(task: Task): Promise<boolean | null>;
  /** Cancel one confined remote run without touching another slot. */
  /** null = not remote, false = remote cancellation still unconfirmed, true = stopped. */
  cancelTask(taskId: string): Promise<boolean | null>;
}

export function createRemoteNodeLane(host: RemoteNodeHost): RemoteNodeLane {
  const { svc, log, emit, inFlight, releaseAndEmit } = host;

  /**
   * The LAST run id created on a node for a task, kept per task and PERSISTED on the card
   * (`tasks.node_run_id`): a restart of this server must not forget the run, or the next dispatch
   * skips the cancel and the node hands the old finished copy back (13/11).
   *
   * Deliberately NOT in `inFlight`: a buried run leaves `inFlight`, and it is
   * exactly then that this id is needed. A run this board gave up on may still
   * be working on the node, so the next dispatch of the same card cancels it
   * first (KANBAN-77) - without that the card collects two deliveries and two
   * branches.
   */
  const lastNodeRun = {
    get: (taskId: string): string | null => svc.nodeRunOf(taskId),
    set: (taskId: string, runId: string): void => svc.setNodeRun(taskId, runId),
    delete: (taskId: string): void => svc.setNodeRun(taskId, null),
  };
  /**
   * One `node-run` hook at a time per machine. The hook wakes the machine and
   * syncs the repo over one tunnel: on 10/11 five cards for the PC ran it
   * together, all five timed out on the tunnel and were vetoed, round after
   * round, while one alone was ready in 26 s. Queued, they start one by one.
   */
  const nodeHookChains = new Map<string, Promise<unknown>>();
  function serialPerMachine<T>(machineId: string, job: () => Promise<T>): Promise<T> {
    const prev = nodeHookChains.get(machineId) ?? Promise.resolve();
    const next = prev.then(job, job);
    const tail = next.catch(() => undefined);
    nodeHookChains.set(machineId, tail);
    void tail.then(() => { if (nodeHookChains.get(machineId) === tail) nodeHookChains.delete(machineId); });
    return next;
  }

  /** Cards whose launch this process started and has not finished yet (see `remoteLaunch`). */
  const launching = new Set<string>();

  /**
   * Consecutive STARTS of a task answered with a cloud account error
   * (`cloud_setup`), kept per task because the slot dies with each failed start.
   * Same hysteresis as the poll (`NODE_SETUP_POLLS`): one credential read that
   * times out on a loaded Mac defers the card, only a run of them parks it.
   * Cleared by any start that gets past the account (a run, or another error).
   */
  const startSetupFails = new Map<string, number>();

  /** The node's name as a person reads it, with the id as the honest fallback. */
  function nodeName(machineId: string): string {
    try { return host.client?.nameOf(machineId) || machineId; } catch { return machineId; }
  }

  /** The DECLARED reason of a failed node call (`NodeError.reason`), when it carries one. */
  /** The park line for an account the node refuses (`cloud_setup`): the cause, not "not answering". */
  function cloudSetupParkReason(name: string, err: unknown): string {
    const why = err instanceof Error ? err.message : String(err);
    return `«${name}» non può lavorare questa card: ${why}. Non è un nodo muto, è l'account: controlla il login ` +
      "di Claude Code su questa macchina (o TOPICS_CLAUDE_CLOUD_ACCOUNT) e i suoi ambienti cloud, oppure togli la macchina dalla card.";
  }

  function nodeFailureReason(err: unknown): string | null {
    const r = (err as { reason?: unknown } | null)?.reason;
    return typeof r === "string" ? r : null;
  }

  /**
   * The node did not answer: the card waits HERE, in the queue, and says why.
   * It NEVER falls back to a local turn - that is the whole point of choosing a
   * machine by hand (KANBAN-76).
   *
   * Except a card the SYSTEM moved there (`task.overflowedAt`) while a breaker
   * is open (`untilMs`): deferred with its pin, it sat out the whole window and
   * then went back to the same node (21/11: deferred 22:10 -> 22:25, breaker
   * open until 22:25). It leaves the node at once, with no deferral, and
   * `nodeBlocked` keeps that machine, the cloud included, out of the next
   * tick's choice (`pickOverflowMachine`). A card a person pinned there waits
   * for it, the asymmetry of `parkNodeCard`.
   *
   * Two writes because no single service call does both. `deferForWait` is the
   * only writer of `dispatch_deferred_until`, and it also refunds the attempt
   * the claim had already spent; `setDispatchState` is what puts the SENTINEL
   * in `dispatch_error`, because `deriveQueueReason` matches a word and not the
   * prose the deferral leaves there.
   */
  function deferForSilentNode(task: Task, why: string, untilMs?: number | null): void {
    if (untilMs && task.overflowedAt && requeueOffMachine(task.id,
      `${NODE_LEFT_NOTE}: ${why}; fino alle ${hourLabel(untilMs)} non riceve card. Torna in coda e parte dove c'è posto.`,
      NODE_LEFT_NOTE)) return;
    try {
      // With the wake breaker open the card waits until it closes, not the fixed 5 minutes:
      // the doubling window (15 min … 4 h) was announced on the card and never applied to it.
      const minutes = untilMs ? Math.max(NODE_RETRY_MINUTES, Math.ceil((untilMs - Date.now()) / 60_000)) : NODE_RETRY_MINUTES;
      const after = host.deferWait(task.id, why, minutes, "machine");
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

  /**
   * Back to the queue with NO fixed machine, at once: the next tick places the
   * card wherever it can run, and the attempt the claim spent is refunded.
   * `false` = the requeue itself failed, and the caller decides what that means.
   */
  function requeueOffMachine(taskId: string, note: string, replaces?: string, skipMachineId?: string): boolean {
    try { releaseAndEmit({ taskId, requeue: true, rollbackAttempt: true }); }
    catch (err) { log(`nodo: la card ${taskId} non è tornata in coda`, err); return false; }
    // The skip names THAT machine for a while: the overflow does not send the card back there, any other seat is fair game.
    // Skips accumulate (one id per node, comma-joined in the one column): two nodes that both refuse must not trade the card forever.
    const skipped = skipMachineId ? [...new Set([...(svc.get(taskId)?.task?.overflowSkipMachines ?? []), skipMachineId])] : [];
    const skip = skipMachineId ? { machineId: skipped.join(","), until: new Date(Date.now() + MODEL_SKIP_MS).toISOString() } : null;
    try { emit(svc.update({ taskId, actor: "agent", by: "dispatcher", patch: { machineId: null, ...(skip ? { overflowSkip: skip } : {}) } })); }
    catch (err) { log(`nodo: la card ${taskId} non ha lasciato la macchina fissa`, err); }
    try { svc.addComment({ taskId, author: "system", kind: "service", content: note, ...(replaces ? { replaces } : {}) }); }
    catch { /* the requeue stands without its line */ }
    return true;
  }

  /**
   * A card that can never start where it is pointed: parked, with the fix in
   * words. The pin to that node survives the park (`release` never touches
   * `machineId`): a card the SYSTEM overflowed there (`task.overflowedAt`)
   * came back here blocked on the same broken node every time a human dragged
   * it back to `todo`, because nothing ever cleared the pin. A card a person
   * pinned there by hand keeps it, with the reason on it — same asymmetry as
   * `returnEmptyNodeRunToTodo`.
   */
  function parkNodeCard(task: Task, reason: string): void {
    try { releaseAndEmit({ taskId: task.id, requeue: false, parkState: CHIP_BLOCKED, reason }); }
    catch (err) { log(`nodo: parcheggio della card ${task.id} non riuscito`, err); return; }
    if (task.overflowedAt) {
      try { emit(svc.update({ taskId: task.id, actor: "agent", by: "dispatcher", patch: { machineId: null } })); }
      catch (err) { log(`nodo: la card ${task.id} bloccata non è tornata sulla macchina locale`, err); }
    }
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
    settings: { effort: string; model?: string; timeoutMin: number },
  ): Promise<void> {
    const node = host.client!;
    const machineId = task.machineId!;
    const name = nodeName(machineId);
    const baseUrl = node.baseUrlOf(machineId);
    const capabilityId = task.delegatedStartCapabilityId ?? null;
    const policy = capabilityId ? host.delegatedPolicyForTask?.(task.id) ?? null : null;
    if (capabilityId && (!policy || policy.id !== capabilityId || policy.machineId !== machineId)) {
      parkNodeCard(task, "Delegated start authorization is no longer valid.");
      return;
    }
    const token = policy
      ? node.delegatedTokenOf?.(machineId, policy.id) ?? null
      : node.tokenOf(machineId);
    if (!baseUrl || !token) {
      deferForSilentNode(
        task,
        `il nodo «${name}» non risponde` + (baseUrl ? " (nessun accoppiamento valido)" : " (nessun indirizzo noto)"),
      );
      return;
    }
    // THE BREAKER IS READ BEFORE THE HOOK. An open breaker means recent runs could not start
    // there, online heartbeat or not: running the hook again only adds one more failure and one
    // more note. The card waits until the breaker closes (the claim already tried to move it to
    // another machine through `machineForbidden`). Fixed reason, no clock in it: the wait series
    // counts it as the same wait.
    const blockedUntil = wakeBreaker.openUntil(machineId);
    if (blockedUntil) {
      deferForSilentNode(task, `il nodo «${name}» non si sveglia da più tentativi`, blockedUntil);
      return;
    }
    // Same read, same reason, for the OTHER breaker: a node that accepted the
    // last two runs and then answered neither.
    const hungUntil = hangBreaker.openUntil(machineId);
    if (hungUntil) {
      deferForSilentNode(task, `il nodo «${name}» non risponde più da due corse di fila`, hungUntil);
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
    // The commits the node is about to make must carry THIS checkout's
    // identity, not one the node invents: LAND-13 refuses any other author.
    // Missing identity is not a silent node (retrying changes nothing), so it
    // parks the card with the fix in words instead of deferring.
    const gitIdentity = await Promise.resolve(node.gitIdentityOf?.(task.projectId) ?? null).catch(() => null);
    if (node.gitIdentityOf && !gitIdentity && !node.skipsGitIdentity?.(baseUrl)) {
      parkNodeCard(
        task,
        `Questa card è assegnata al nodo «${name}», ma questo checkout non ha un'identità git (\`git config user.name\`/` +
          "`user.email`): senza di essa il land rifiuterebbe i commit della corsa come di un autore estraneo. " +
          "Configura l'identità git di questo progetto, oppure togli la macchina dalla card.",
      );
      return;
    }
    // A CARD THAT ALREADY HAS A BRANCH STARTS FROM IT over there (a rerun after
    // a review). Started from main, the delivery lacked that branch's commits and
    // conflicted with them at the land (df5fd8c5, 30/10/2026: 5 files). The node
    // can only start from what origin has, so the branch is pushed first; a
    // branch that cannot reach origin keeps the card from starting at all.
    let baseBranch: string | null = null;
    const carried = carriedBranch(task);
    if (carried && !policy && node.ensureBranchOnOrigin) {
      const branch = carried;
      const ready = await Promise.resolve(node.ensureBranchOnOrigin({ projectId: task.projectId, branch }))
        .catch((err): { ok: false; reason: string } => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }));
      if (!ready.ok) {
        parkNodeCard(
          task,
          `Questa card ha già il ramo «${branch}», ma su origin non c'è e non si è potuto pusharlo (${ready.reason}). ` +
            `Il nodo «${name}» partirebbe da main senza i suoi commit: pusha il ramo, oppure togli la macchina dalla card.`,
        );
        return;
      }
      baseBranch = branch;
    }
    if (policy) {
      let begun: boolean | number = false;
      try {
        begun = host.recordDelegatedPhase?.({ taskId: task.id, phase: "dispatch" }) ?? false;
      } catch (err) {
        log(`nodo: begin delegato per ${task.id} non persistito`, err);
      }
      if (typeof begun !== "number" || !Number.isFinite(begun)) {
        parkNodeCard(task, "Delegated dispatch authorization could not be persisted.");
        return;
      }
    }
    // A node key from the first instant, before the node has named its run:
    // every local census reads the key, and an empty one counted this run as a
    // turn of THIS machine while the hook and `createRun` were still answering.
    const runNo = host.beginRun(task.id, nodeSessionKey(machineId, "pending"));
    try {
      // THE `node-run` HOOK COMES BEFORE ANY CALL TO THE NODE, the cancel of
      // the previous run included: it is what wakes a sleeping machine. A veto
      // is deferred like a silent node (no attempt burned) with the hook's own
      // words as the reason. Awaiting here is safe: `launch` is fired without
      // await by the tick, and the slot is already ours.
      const hooks = node.hooks ?? defaultLifecycleHooks();
      const verdict: HookOutcome = await serialPerMachine(machineId, () => hooks.run("node-run", {
        hook_event_name: "node-run",
        session_id: task.id,
        cwd: node.projectPathOf?.(task.projectId) ?? "",
        task_id: task.id,
        project_id: task.projectId,
        machine_id: machineId,
        machine_name: name,
        node_base_url: baseUrl,
        origin_url: originUrl,
        git_author_name: gitIdentity?.name ?? "",
        git_author_email: gitIdentity?.email ?? "",
      })).catch((err): HookOutcome => {
        // A runner that throws said nothing: same rule as a hook that never answered.
        log(`nodo: l'hook node-run per ${task.id} non si è avviato`, err);
        return { ok: true };
      });
      if (!verdict.ok) {
        host.endRun(task.id, runNo);
        wakeBreaker.failure(machineId);
        const until = wakeBreaker.openUntil(machineId);
        // A card that leaves the node says this in its own note (`deferForSilentNode`): one note, not two.
        if (until && !task.overflowedAt) {
          try {
            svc.addComment({ taskId: task.id, author: "system", kind: "service",
              content: `«${name}» non si sveglia da più tentativi: fino alle ${hourLabel(until)} non gli mando altre card.` });
          } catch { /* the note never blocks the deferral */ }
        }
        deferForSilentNode(task, `il nodo «${name}» non è pronto: ${verdict.reason}`, until);
        return;
      }
      // THE OLD RUN DIES BEFORE A NEW ONE IS BORN. A run this board buried may
      // still be working over there, and two live runs on one card means two
      // deliveries and two branches (KANBAN-77).
      const previous = lastNodeRun.get(task.id);
      if (previous) {
        try { await node.cancelRun({
          baseUrl, token, runId: previous,
          delegation: policy ? {
            capabilityId: policy.id,
            subjectPersonId: policy.initiatorPersonId,
            subjectDeviceId: policy.initiatorDeviceId,
          } : undefined,
        }); }
        catch (err) { log(`nodo: la corsa ${previous} non si è cancellata`, err); }
        lastNodeRun.delete(task.id);
      }
      const runInput: Parameters<typeof node.createRun>[0] = {
        baseUrl,
        token,
        ...(policy ? { delegation: {
          capabilityId: policy.id,
          subjectPersonId: policy.initiatorPersonId,
          subjectDeviceId: policy.initiatorDeviceId,
        } } : {}),
        body: {
          originTaskId: task.id,
          originUrl,
          text: task.text,
          // The node cannot `get_task` a card that lives here: the thread (review feedback,
          // previous delivery) travels with it, or a rerun repeats the first round. Not to a
          // confined guest device: the owner's discussion is not part of what it was granted.
          // The board's language rides last: the node has no role prompt and no envelope of ours.
          description: withNodeRunLanguage(
            policy ? task.description ?? "" : nodeRunDescription(task.description, svc.get(task.id)?.comments ?? []),
            host.languageOf?.(task.projectId),
          ),
          model: policy?.model ?? task.model ?? settings.model ?? null,
          effort: policy ? settings.effort : (settings.effort && settings.effort !== "auto" ? settings.effort : null),
          ...(baseBranch ? { baseBranch } : {}),
        },
      };
      let created: { runId: string };
      try {
        created = await node.createRun(runInput);
        wakeBreaker.success(machineId);
      } catch (err) {
        // The node cannot reach origin (it does not talk to GitHub by choice): the
        // carried branch rides with the run as a bundle, as the delivery rides back.
        if (!baseBranch || !(isNodeError(err) && err.reason === "branch_unreachable") || !node.bundleBranch) throw err;
        const bytes = await node.bundleBranch({ projectId: task.projectId, branch: baseBranch });
        if (!bytes) throw err;
        created = await node.createRun({ ...runInput, body: { ...runInput.body, branchBundle: Buffer.from(bytes).toString("base64") } });
      }
      const { runId } = created;
      startSetupFails.delete(task.id);
      lastNodeRun.set(task.id, runId);
      if (!host.ownsRun(task.id, runNo)) {
        // Superseded while the node was answering: the run we just created has
        // no owner here, and leaving it alive is the two-deliveries defect.
        try { await node.cancelRun({ baseUrl, token, runId, delegation: policy ? {
          capabilityId: policy.id,
          subjectPersonId: policy.initiatorPersonId,
          subjectDeviceId: policy.initiatorDeviceId,
        } : undefined }); } catch { /* best-effort */ }
        return;
      }
      host.bindRunSession(task.id, runNo, nodeSessionKey(machineId, runId));
      if (policy) {
        let bound: boolean | number = false;
        try {
          bound = host.recordDelegatedPhase?.({
            taskId: task.id,
            phase: "dispatch",
            executionSessionId: nodeSessionKey(machineId, runId),
          }) ?? false;
        } catch (err) {
          log(`nodo: binding audit della corsa ${runId} fallito`, err);
        }
        if (typeof bound !== "number" || !Number.isFinite(bound)) {
          let cancellationConfirmed = false;
          try {
            await node.cancelRun({ baseUrl, token, runId, delegation: {
              capabilityId: policy.id,
              subjectPersonId: policy.initiatorPersonId,
              subjectDeviceId: policy.initiatorDeviceId,
            } });
            cancellationConfirmed = true;
          } catch (err) {
            log(`nodo: cancellazione della corsa non legata ${runId} fallita`, err);
          }
          if (!cancellationConfirmed) {
            const slot = inFlight.get(task.id);
            if (slot) slot.node = {
              machineId, baseUrl, token, runId, fails: 0, seen: new Set(), primed: false,
              delegation: {
                capabilityId: policy.id,
                subjectPersonId: policy.initiatorPersonId,
                subjectDeviceId: policy.initiatorDeviceId,
              },
              cancelPending: true,
              cancelReason: "audit_binding_failed",
            };
            try {
              emit(svc.setDispatchState({
                taskId: task.id,
                state: CHIP_BLOCKED,
                error: "delegated_cancel_unconfirmed",
              }));
            } catch { /* the exact run remains bound for the next retry */ }
            return;
          }
          lastNodeRun.delete(task.id);
          host.endRun(task.id, runNo);
          parkNodeCard(task, "Remote run started but its delegated audit binding failed; it was cancelled.");
          return;
        }
      }
      const slot = inFlight.get(task.id);
      if (slot) slot.node = {
        machineId, baseUrl, token, runId, fails: 0, seen: new Set(), primed: false,
        ...(policy ? { delegation: {
          capabilityId: policy.id,
          subjectPersonId: policy.initiatorPersonId,
          subjectDeviceId: policy.initiatorDeviceId,
        } } : {}),
      };
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
      // A 413 is a verdict on the request, not a silence: the same body is refused
      // every time, so retrying every 5 minutes forever helps nobody. Park with the size.
      if (nodeFailureReason(err) === "payload_too_large") {
        const why = err instanceof Error ? err.message : String(err);
        parkNodeCard(
          task,
          `Il nodo «${name}» ha rifiutato la card perché troppo grande: ${why}. ` +
            "Accorcia la descrizione o il thread della card, oppure togli la macchina dalla card.",
        );
        return;
      }
      // The node does not run this card's model: another machine may. The card
      // goes back to the queue with no fixed machine and says so in its thread.
      if (nodeFailureReason(err) === "model_rejected") {
        if (!requeueOffMachine(task.id, `Il nodo «${name}» non esegue il modello di questa card. Tolgo la macchina fissa e la rimetto in coda: parte dove il modello c'è.`, undefined, machineId)) {
          parkNodeCard(task, `Il nodo «${name}» non esegue il modello della card.`);
        }
        return;
      }
      // The cloud cannot run THIS card for a reason that waiting does not fix: its repository is out
      // of the GitHub app's reach, or the account is refused (no environment, token refused). The
      // card goes back to the queue with no fixed machine, at once, and says the real cause: it
      // runs where it can, and the cloud is not chosen again for it until the answer changes.
      const reason = nodeFailureReason(err);
      if (reason === "cloud_repo" || reason === "cloud_account") {
        const why = err instanceof Error ? err.message : String(err);
        if (!requeueOffMachine(task.id, `«${name}» non può lavorare questa card: ${why}. Tolgo la macchina fissa e la rimetto in coda: parte dove può girare.`)) {
          parkNodeCard(task, `«${name}» non può lavorare questa card: ${why}`);
        }
        return;
      }
      // A 400/422 is the node refusing THIS card (12/11: a model outside its
      // catalog, retried every 5 minutes for half an hour as a silent node).
      if (nodeFailureReason(err) === "rejected") {
        const why = err instanceof Error ? err.message : String(err);
        parkNodeCard(
          task,
          `Il nodo «${name}» ha rifiutato la card: ${why}. ` +
            "Correggi la card (per esempio il modello) oppure togli la macchina dalla card.",
        );
        return;
      }
      // The node answered, and what it said is that THIS ACCOUNT cannot run there
      // (no active cloud environment, credentials refused): waiting does not fix
      // it, so the card stops with the cause instead of "not answering" for half an
      // hour (30/10/2026: 7 cards, 31 minutes, a Keychain login switched account).
      // Parked only after `NODE_SETUP_POLLS` such answers in a row, like the
      // poll: a single credential read that times out is not the account.
      if (nodeFailureReason(err) === "cloud_setup") {
        const fails = (startSetupFails.get(task.id) ?? 0) + 1;
        if (fails >= NODE_SETUP_POLLS) {
          startSetupFails.delete(task.id);
          parkNodeCard(task, cloudSetupParkReason(name, err));
          return;
        }
        startSetupFails.set(task.id, fails);
        log(`nodo: avvio su «${name}» rifiutato dall'account per ${task.id} (${fails}/${NODE_SETUP_POLLS})`, err);
        const why = err instanceof Error ? err.message : String(err);
        deferForSilentNode(task, `«${name}» non ha accettato l'avvio (${why}), riprovo`);
        return;
      }
      startSetupFails.delete(task.id);
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
    settings: { effort: string; model?: string; timeoutMin: number },
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
    // THE LAUNCH IS IN FLIGHT BEFORE IT HOLDS A SLOT. `launchOnNode` awaits the
    // origin lookup and the push of the card's branch before `beginRun`, and a
    // push takes seconds. In that window the card is `in_progress` with nothing
    // in `inFlight`, which is exactly what the restart orphan pass looks for:
    // it requeued the card with the server-restart note (no restart), the tick
    // launched it a second time, the two pushes of the same ref collided, and
    // the loser parked the card in backlog while the winner's run went on
    // working on the node (91a42e8f, a5906c31, 841c6eac on 2026-11-03).
    launching.add(taskId);
    return launchOnNode(claimedTask, settings).finally(() => { launching.delete(taskId); });
  }

  /**
   * The opening of the note a buried REMOTE run leaves, and the slot it lives
   * in. Same discipline as `DEAD_SESSION_NOTE`: the sentence describes a
   * condition, not an event worth counting, so a second burial replaces it
   * instead of adding a paragraph.
   */
  const NODE_BURIED_NOTE = "La corsa sul nodo non risponde più";
  const NODE_LOST_NOTE = "Corsa sul nodo persa";

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
    // The node did not answer for a whole burial, same signal as a wake that
    // never brought it up: the shared breaker opens after the SECOND one, so
    // the next dispatch does not hand the very next card to a machine that
    // just proved it is not there (measured 21/11: 30 rounds, bury, reassign,
    // repeat, for hours, while other boards starved behind the same node).
    hangBreaker.failure(node.machineId);
    // A card that meanwhile went to review, done or the archive is NEVER
    // requeued: the requeue put it back in todo and the node-run hook woke a
    // paid server for a card already closed (10/11, topics-node-p1). The run
    // closes as lost and the card stays where it is.
    const current = svc.get(taskId)?.task;
    if (current && (svc.isArchived?.(taskId) || current.status === "review" || current.status === "done")) {
      try {
        svc.addComment({
          taskId, author: "system", kind: "service",
          replaces: NODE_LOST_NOTE,
          content: `${NODE_LOST_NOTE}: «${name}» non ha risposto a ${NODE_DEAD_POLLS} giri consecutivi e la card era già chiusa. Nessuna ripartenza.`,
        });
      } catch { /* dedupe/best-effort */ }
      try { releaseAndEmit({ taskId, requeue: false, keepStatus: true }); }
      catch (err) { log(`nodo: la corsa persa di ${taskId} non si è chiusa`, err); }
      return;
    }
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
    // Still waiting for the node to name its run: nothing local to probe.
    if (!slot.node) return isNodeSessionKey(slot.sessionKey) ? "wait" : "local";
    return slot.node.fails >= NODE_DEAD_POLLS ? "bury" : "wait";
  }

  /** The node's diffstat, when it measured one. `null` is "not measured", never zero. */
  function nodeStat(raw: unknown): { filesChanged: number; insertions: number; deletions: number } | null {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as { filesChanged?: unknown; insertions?: unknown; deletions?: unknown };
    if (typeof o.filesChanged !== "number" || typeof o.insertions !== "number" || typeof o.deletions !== "number") return null;
    return { filesChanged: o.filesChanged, insertions: o.insertions, deletions: o.deletions };
  }

  /** An agent's signature on the node: bare `agent` or `agent:<id>`. */
  function isAgentAuthor(author: string | null | undefined): author is string {
    return typeof author === "string" && (author === "agent" || author.startsWith("agent:"));
  }

  /**
   * The signature an agent row gets on THIS card. The id after `agent:` is the
   * node's own word: only a plain id survives, anything else collapses to the
   * bare `agent`, so a hostile or garbled signature never reaches the thread.
   */
  function boundAgentAuthor(author: string): string {
    return /^agent:[\w-]{1,64}$/.test(author) ? author : "agent";
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
    // The node's spend lands on THIS card, so the origin's project meter sees it.
    // Absolute floors: the same report twice moves nothing.
    if (report.usage && (report.usage.tokens > 0 || report.usage.costCents > 0)) {
      try {
        emit(svc.raiseAgentUsage({
          taskId, tokens: report.usage.tokens, cacheReadTokens: report.usage.cacheReadTokens, costCents: report.usage.costCents,
        }));
      } catch (err) { log(`nodo: consumo non specchiato su ${taskId}`, err); }
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
      const fromAgent = isAgentAuthor(c.author);
      try {
        svc.addComment({
          taskId,
          // THE AGENT KEEPS ITS VOICE. On the node an agent signs `agent:<id>`,
          // and the old exact match on `"agent"` turned every one of its rows
          // into a system note: the review door then found no agent comment and
          // wrote its no-summary note under a summary that was there,
          // and the agent's question lost its buttons (91a42e8f, a5906c31,
          // 841c6eac on 2026-11-03, every PC delivery of that day).
          author: fromAgent ? boundAgentAuthor(c.author) : "system",
          // Only the thread: the node's CHAT never travels here, and the report
          // carries none by construction (`/api/nodes/runs/:id` returns task
          // comments and nothing else). An agent's comment stays a comment;
          // what the node's own machinery wrote stays bookkeeping.
          kind: c.kind === "delivery" ? "delivery" : fromAgent && c.kind === "comment" ? "comment" : "service",
          content: c.content,
          messageId: c.id,
        });
        node.seen.add(c.id);
      } catch (err) { log(`nodo: commento ${c.id} non specchiato su ${taskId}`, err); }
    }
  }

  /**
   * A node delivery reaches review here, never through the route that emits `task-deliver`, so the
   * user's hook (a retrospective, an audit) would never see a card that ran on a node. Emit the same
   * event with the node's own account of the run, because its chat lives in the node's database.
   * Detached and swallowed: a delivery that already landed must not wait on, or fail for, a hook.
   */
  function fireNodeDeliverHook(delivered: { id: string; projectId: string }, node: NodeSlot, report: NodeRunReport): void {
    try {
      const hooks = host.client?.hooks ?? defaultLifecycleHooks();
      if (hooks.declares && !hooks.declares("task-deliver")) return;
      const comments = report.comments.slice(-12).map((c) => ({ author: c.author, content: c.content.slice(0, 2000) }));
      void hooks.run("task-deliver", {
        hook_event_name: "task-deliver",
        session_id: delivered.id,
        cwd: host.client?.projectPathOf?.(delivered.projectId) ?? "",
        task_id: delivered.id,
        project_id: delivered.projectId,
        commit: report.deliveryCommit,
        node_run: true,
        machine_id: node.machineId,
        node_comments: comments,
      }).catch((err) => log(`nodo: hook task-deliver di ${delivered.id} non riuscito`, err));
    } catch (err) { log(`nodo: hook task-deliver di ${delivered.id} non avviato`, err); }
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
    svc.closeNodeRun(taskId);
    const task = svc.get(taskId)?.task;
    if (!task) return;
    const branch = report.deliveryBranch;
    let planted: PlantBranchResult = {
      planted: false, commit: null, commitCount: 0, reason: report.reason || "il nodo non ha consegnato nessun ramo",
    };
    if (branch) {
      let bundle: Uint8Array | null = null;
      let fetchFailed: string | null = null;
      try {
        const got: BundleResult = await client.fetchBundle({
          baseUrl: node.baseUrl, token: node.token, runId: node.runId, delegation: node.delegation,
        });
        bundle = got.empty ? null : got.bytes;
      } catch (err) {
        fetchFailed = `il bundle non è arrivato dal nodo «${name}»`;
        log(`nodo: bundle della corsa ${node.runId} non scaricato`, err);
      }
      planted = fetchFailed
        ? { planted: false, commit: null, commitCount: 0, reason: fetchFailed }
        : await client
          .plantBranch({ projectId: task.projectId, branch, baseSha: report.baseSha, bundle })
          .catch((err): PlantBranchResult => {
            log(`nodo: impianto del ramo ${branch} fallito`, err);
            return { planted: false, commit: null, commitCount: 0, reason: "l'impianto del ramo è fallito su questa macchina" };
          });
      // The bundle download and the plant are awaits: a card closed meanwhile
      // keeps the delivery it was closed with, and the run is cancelled.
      if (svc.get(taskId)?.task?.status === "done") {
        await retireDoneRun(taskId, node);
        return;
      }
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
      } else {
        // The node's commit, with the branch columns left alone: the land then
        // finds a delivered commit this checkout lacks and refuses, instead of
        // landing `priorBranch`, the round a person sent back. Recording the
        // node's branch would also break the next run, which starts from a
        // branch it must find here or on origin.
        try {
          svc.recordDelivery({
            taskId, branch: svc.get(taskId)?.task?.deliveryBranch ?? null,
            commit: report.deliveryCommit || UNPLANTED_DELIVERY_COMMIT,
          });
        } catch (err) { log(`node: unplanted delivery not recorded on ${taskId}`, err); }
      }
    }
    const fresh = svc.get(taskId)?.task;
    // The planted branch's own commit COUNT above its base, not the run's: a
    // run that adds nothing to a branch already ahead of main is a delivery
    // the review door must see, and `commitCount` answers that regardless of
    // what THIS run's own-commit capture could attribute to it.
    const producedNothing = planted.planted
      ? !!fresh && planted.commitCount === 0
      : !branch && !report.reason && !report.dispatchError;
    if (fresh && producedNothing && returnEmptyNodeRunToTodo({ svc, releaseAndEmit, emit, log, nameOf: nodeName }, fresh, name)) return;
    const reason = planted.planted
      ? `Consegnato dal nodo «${name}»: il ramo \`${branch}\` è stato piantato in questo checkout` +
        (planted.commit ? ` su \`${planted.commit.slice(0, 8)}\`.` : ".")
      : `Consegnato dal nodo «${name}», ma il ramo non è arrivato: ${planted.reason ?? "motivo non dichiarato"}.`;
    const nextMove = planted.planted
      ? "Da qui l'atterraggio è quello di sempre: guarda il diff e approva, oppure rimandala indietro."
      : "Il lavoro è sul nodo, non qui: sistema quello che manca e rimanda indietro la card per farla riconsegnare.";
    try {
      // A planted branch asks nobody anything: the next move is a line of the note, not the card's question.
      // Passed as `nextMove` it became the card's `human_ask`, and a card that asks something is never
      // landed alone nor sent back on a red: every green node delivery waited for a person (14/11, 19d684fb).
      const delivered = planted.planted
        ? svc.deliverToReviewBySystem({ taskId, reason: `${reason} ${nextMove}`, quietReason: true, deliveredTip: planted.commit ?? report.deliveryCommit ?? null })
        : svc.deliverToReviewBySystem({ taskId, reason, nextMove, quietReason: true, deliveredTip: planted.commit ?? report.deliveryCommit ?? null });
      if (node.delegation) {
        try { host.recordDelegatedPhase?.({ taskId, phase: "completed", outcome: "review" }); }
        catch { /* audit never blocks delivery */ }
      }
      emit(delivered);
      fireNodeDeliverHook(delivered, node, report);
      // The review rewrites the chip and clears dispatch_error: a node that closed on an error
      // (the Claude cloud does) gets its code back, so the card does not read like a success.
      if (report.dispatchError) {
        try { emit(svc.setDispatchState({ taskId, state: delivered.dispatchState ?? "needs_input", error: report.dispatchError })); }
        catch (err) { log(`nodo: errore non specchiato su ${taskId}`, err); }
      }
      // Same edge the local system delivery emits: without it the review-ready
      // notification never fires for a card that never passed through the route.
      // Only a card that waits on a PERSON rings (`awaitsHuman`, shared/workflow.ts).
      if (awaitsHuman(delivered)) {
        try {
          host.broadcast({
            type: "task:review-ready",
            projectId: delivered.projectId,
            taskId: delivered.id,
            taskTitle: delivered.text || "Task",
            reason: "system-delivered",
          });
        } catch { /* best-effort */ }
      }
      // A run that closed on an error (a quota stop with half a commit) is planted so a person can
      // see what it left, but it is never measured for a land of its own.
      if (planted.planted && !report.dispatchError) void host.measureDelivery?.(taskId)?.catch((err) => log(`nodo: misura della consegna ${taskId} fallita`, err));
    } catch (err) { log(`nodo: consegna in review non riuscita per ${taskId}`, err); }
  }

  /**
   * The note a retired mirror leaves, replaced (not repeated) if it happens again.
   */
  const NODE_OLD_MIRROR_NOTE = "La corsa sul nodo era la copia della consegna precedente";

  /**
   * Is this report the PREVIOUS round's delivery coming back? A run that has just been created cannot
   * already have delivered, so a first answer in review whose delivery comment this card has already
   * taken in (the anchor is the node's comment id) is the old mirror. It happens after a restart of this
   * server: `lastNodeRun` lives in memory, nobody cancels the old run, and the node answers `createRun`
   * with the live mirror of the card as it is (ff293eda, 26/10: the old branch was landed again).
   */
  function isPreviousDelivery(taskId: string, report: NodeRunReport): boolean {
    const anchored = new Set<string>();
    for (const c of svc.get(taskId)?.comments ?? []) if (c.messageId) anchored.add(c.messageId);
    return report.comments.some((c) => c.kind === "delivery" && anchored.has(c.id));
  }

  /**
   * Cancel the old mirror on the node and send the card back to the queue, attempt refunded: the next
   * dispatch creates a NEW run, with the thread as it is now. `false` = the cancel did not go through,
   * and then nothing else happens: re-queueing would hand the same mirror back.
   */
  async function retirePreviousMirror(taskId: string, node: NodeSlot): Promise<boolean> {
    try {
      await host.client!.cancelRun({ baseUrl: node.baseUrl, token: node.token, runId: node.runId, delegation: node.delegation });
    } catch (err) {
      log(`nodo: la copia vecchia ${node.runId} non si è cancellata`, err);
      return false;
    }
    lastNodeRun.delete(taskId);
    // The slot goes first, as in `landNodeDelivery`: a card still «in flight» is never dispatched again.
    inFlight.delete(taskId);
    try {
      svc.addComment({
        taskId, author: "system", kind: "service",
        replaces: NODE_OLD_MIRROR_NOTE,
        content:
          `${NODE_OLD_MIRROR_NOTE} (il nodo la conservava): l'ho cancellata, la card riparte da capo ` +
          "con la discussione di adesso.",
      });
    } catch { /* dedupe/best-effort */ }
    try { releaseAndEmit({ taskId, requeue: true, rollbackAttempt: true }); }
    catch (err) { log(`nodo: la card ${taskId} non è tornata in coda dopo la copia vecchia`, err); }
    return true;
  }

  /**
   * ONE POLL PER REMOTE SLOT, every reconcile tick. This is the whole life
   * signal of a remote run: there is no promise to await and no process to
   * probe (KANBAN-76, KANBAN-77).
   */
  /**
   * The cloud answered with its weekly-limit wall: the plan is spent until the
   * reset the message names. The hold is set, so the overflow picks the PC while
   * it lasts. A run that brought no branch did no work: the card goes back to
   * the queue and off the cloud, when the overflow put it there, instead of
   * landing in review as an empty delivery. A run that DID deliver a branch
   * still lands: the work is not lost, only the hold is recorded.
   * Returns true when the card was requeued.
   */
  function stopOnWeeklyLimit(taskId: string, report: NodeRunReport, task: Task | undefined): boolean {
    let limit: CloudWeeklyLimit | null = null;
    for (const text of [report.reason, report.dispatchError, ...report.comments.map((c) => c.content)]) {
      limit = text ? parseCloudWeeklyLimit(text) : null;
      if (limit) break;
    }
    if (!limit) return false;
    try { setProviderHold({ untilMs: limit.untilMs, window: "seven_day", reason: limit.reason, provider: CLOUD_HOLD_KEY }); }
    catch (err) { log("nodo: fermo del limite settimanale non registrato", err); }
    // A card put on the cloud by hand would come straight back here until the
    // reset: it stays in review with the message, where a person sees why.
    if (report.deliveryBranch || !task || !task.overflowedAt) return false;
    inFlight.delete(taskId);
    log(`nodo: ${taskId} tornata in coda, limite settimanale del cloud fino a ${new Date(limit.untilMs).toISOString()}`);
    requeueOffMachine(taskId,
      `Il Cloud ha risposto col limite settimanale del piano Claude (riprende ${new Date(limit.untilMs).toISOString().slice(0, 16).replace("T", " ")} UTC). ` +
        "Rimetto la card in coda: finché dura il fermo va sul PC o sul Mac.");
    return true;
  }

  async function poll(): Promise<void> {
    const client = host.client;
    if (!client) return;
    for (const [taskId, slot] of [...inFlight]) {
      const node = slot.node;
      if (!node) continue;
      // A card closed while its run was alive: cancel the run on the node and
      // clear the chip. Left alone, the mirror rewrote `working` on a done card
      // and the delivery that followed carried it back to review (12/11, 17436204).
      if (svc.get(taskId)?.task?.status === "done") {
        await retireDoneRun(taskId, node);
        continue;
      }
      if (node.cancelPending) {
        await cancelTask(taskId);
        continue;
      }
      const task = svc.get(taskId)?.task;
      if (task?.delegatedStartCapabilityId && !host.delegatedPolicyForTask?.(taskId)) {
        await cancelTask(taskId);
        continue;
      }
      // A human PATCHed the card back to `todo` while this remote slot was
      // still open — the usual move to try to restart a card that looks
      // stuck. `inFlight` is dispatcher memory, not a card field: the patch
      // alone never freed it, so the next poll kept re-mirroring the node's
      // old chip onto a card whose mandate had already changed, and the card
      // sat in `todo` forever — only a restart (which empties `inFlight`)
      // ever unstuck it. `review`/`done`/archived are NOT this case: those
      // already have their own dedicated treatment below (never requeued),
      // and unconditionally cancelling here would race it. Cancel the stale
      // run and free the slot: the ordinary dispatch loop picks the card up
      // again on its own, on its next tick.
      if (task && task.status === "todo") {
        inFlight.delete(taskId);
        try {
          await client.cancelRun({ baseUrl: node.baseUrl, token: node.token, runId: node.runId, delegation: node.delegation });
          lastNodeRun.delete(taskId);
        } catch (err) {
          log(`nodo: la corsa ${node.runId} non si è cancellata dopo il cambio di stato di ${taskId}`, err);
        }
        continue;
      }
      let report: NodeRunReport;
      try {
        report = await client.readRun({
          baseUrl: node.baseUrl, token: node.token, runId: node.runId, delegation: node.delegation,
        });
      } catch (err) {
        // The node answered, and what it said is that THIS ACCOUNT cannot reach
        // the run (no active cloud environment, credentials refused). Counted as
        // a silent poll, it buried the run after thirty rounds with "did not
        // answer" and the cause was never written. The run id stays in
        // `lastNodeRun`: the next dispatch cancels it before starting another.
        // Parked only after `NODE_SETUP_POLLS` such answers in a row: a single
        // credential read that times out is not the account.
        if ((nodeFailureReason(err) === "cloud_setup" || nodeFailureReason(err) === "cloud_account") && task) {
          node.setupFails = (node.setupFails ?? 0) + 1;
          if (node.setupFails >= NODE_SETUP_POLLS) {
            const still = inFlight.get(taskId);
            if (!still || still.runId !== slot.runId) continue;
            inFlight.delete(taskId);
            parkNodeCard(task, cloudSetupParkReason(nodeName(node.machineId), err));
            continue;
          }
        } else {
          node.setupFails = 0;
        }
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
      // The card may have been closed while `readRun` was in the air: the first
      // look above predates the report, and mirroring it would write `working`
      // back on a done card.
      if (svc.get(taskId)?.task?.status === "done") {
        await retireDoneRun(taskId, node);
        continue;
      }
      node.fails = 0;
      node.setupFails = 0;
      // The node just answered a poll: whatever closed the breaker before, it
      // is reachable again, and the next card may go to it.
      hangBreaker.success(node.machineId);
      if (!node.primed && report.status === "review" && isPreviousDelivery(taskId, report)) {
        if (await retirePreviousMirror(taskId, node)) continue;
        node.retireFails = (node.retireFails ?? 0) + 1;
        if (node.retireFails >= NODE_RETIRE_TRIES && task) {
          inFlight.delete(taskId);
          parkNodeCard(
            task,
            `Il nodo «${nodeName(node.machineId)}» ha ancora la copia della consegna precedente (corsa \`${node.runId.slice(0, 8)}\`) ` +
              "e non la cancella: cancellala là, poi rimetti la card in coda.",
          );
        }
        continue;
      }
      mirrorNodeReport(taskId, node, report);
      // The node parked the run ITSELF (`backlog` + `failed`/`blocked`: its own
      // dispatch ran out of road, e.g. no runtime for the model). It will never
      // come back no matter how many more times this polls it, and mirroring
      // the chip forever only kept the slot open and the card frozen wherever
      // it happened to be. Close the slot here and park the card with the
      // node's own reason, instead of waiting for a human to notice the chip
      // and drag the card back to `todo`.
      if (
        task && task.status === "in_progress" && !svc.isArchived?.(taskId)
        && report.status === "backlog" && (report.dispatchState === "failed" || report.dispatchState === CHIP_BLOCKED)
      ) {
        inFlight.delete(taskId);
        lastNodeRun.delete(taskId);
        const why = report.reason || report.dispatchError || "nessun motivo riportato";
        // The node has no agent for this card's model: a verdict on the node, not a failed start. The card
        // leaves it (no attempt spent, nothing parked) and the node is skipped for it.
        if (isModelUnavailable(why) && requeueOffMachine(taskId, `Il nodo «${nodeName(node.machineId)}» non ha il modello di questa card. La rimetto in coda: parte su un'altra macchina.`, undefined, node.machineId)) continue;
        parkNodeCard(task, `Il nodo «${nodeName(node.machineId)}» ha parcheggiato la corsa: ${why}`);
        continue;
      }
      if (report.status !== "review") continue;
      if (stopOnWeeklyLimit(taskId, report, task)) continue;
      // A paired node never sends `reason`: review with no branch and no error may be
      // the half second between the node's two writes, so give it a few polls.
      if (!report.deliveryBranch && !report.reason && !report.dispatchError) {
        node.reviewWithoutBranch = (node.reviewWithoutBranch ?? 0) + 1;
        if (node.reviewWithoutBranch < NODE_BRANCH_GRACE_POLLS) continue;
      }
      await landNodeDelivery(taskId, node, report);
    }
    // Never awaited: a node that does not answer must not hold the poll, and the recovery behind it.
    if (!mirrorSweep) {
      mirrorSweep = retireClosedMirrors()
        .catch((err) => log("node: retired mirrors sweep failed", err))
        .finally(() => { mirrorSweep = null; });
    }
  }

  /**
   * A card that names a NODE is never RESUMED here (the recovery in `reconcile`
   * ends in `resume`, which opens a local topic and a local turn: for a remote
   * card that is the one thing KANBAN-76 forbids), but its run is not thrown
   * away either. `tasks.node_run_id` and the machine's `baseUrl`/token survive a
   * restart (13/11): what lived only in memory was the slot, not the run, so
   * this asks the node (with a timeout: a boot that waits on one hung node for
   * every other card is the queue's own failure mode) whether that run is
   * still OPEN — in_progress, todo (its grace window) or review, never the
   * card's own stale idea of the status — and REATTACHES the slot instead of
   * queueing over it. Only when the node says the run is gone, done or
   * parked, or answering fails, is the queue the honest move - the tick
   * re-dispatches the card, and that dispatch cancels the old run before
   * creating a new one (KANBAN-77). export-morti-2 lost 257 files and a clean
   * typecheck to three restarts before this (22/11, 0ed45466).
   */
  async function queueAfterRestart(task: Task): Promise<boolean | null> {
    if (!task.machineId || !host.client) return null;
    // Still being launched by this process: not an orphan of a restart.
    if (launching.has(task.id)) return false;
    // The chip is no sign of an orphan: a remote card's chip is copied from the node by the poll
    // (needs_input, waiting...). What persists is whether a run is still open on the node. A card a
    // human closed and dragged back to In Progress has none: nothing to relaunch, leave it be.
    const runOpen = svc.nodeRunIsOpen(task.id);
    if (!runOpen) {
      // With no open run a card is either dragged to In Progress by hand (not an orphan: leave
      // it) or CUT BY THE SERVER while the launch had not created the run yet. The two differ by
      // the cut: `interrupted_at`, written by the shutdown, is later than the entry into
      // in-progress. Left alone, the second stayed in_progress forever with the node slot
      // counted as busy (f4dbe271, 17/11: the token rotation waited two days).
      const cut = task.interruptedAt, since = task.inProgressAt;
      if (!cut || !since || cut < since) return false;
    }
    if (task.delegatedStartCapabilityId && !host.delegatedPolicyForTask?.(task.id)) {
      try {
        releaseAndEmit({
          taskId: task.id,
          requeue: false,
          rollbackAttempt: true,
          parkState: CHIP_BLOCKED,
          reason: "Delegated start authorization is no longer valid.",
        });
        return true;
      } catch (err) {
        log(`node: revoked delegated card ${task.id} was not stopped after restart`, err);
        return false;
      }
    }
    const runId = runOpen ? svc.nodeRunOf(task.id) : null;
    if (runOpen && runId) {
      const outcome = await reattachOpenRun(task, runId);
      if (outcome !== "queue") return false; // reattached, or another path already owns the card
    }
    // A race can land here too (readRun said the run is closed WHILE another path was
    // already relaunching the same card): the same freshness check `reattachOpenRun`
    // runs before touching its slot, run one more time before requeueing over it.
    if (!stillOursToHandle(task.id, runId)) return false;
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

  /**
   * A run the node still counts as open: ongoing, in its grace window, or
   * finished but not yet landed here. `backlog` (parked by the node itself)
   * and `done` are NOT this - reattaching to either leaves the slot occupied
   * forever over a run that will never move again (regression found 22/11:
   * the old code checked only that `readRun` did not throw, so a 200 for a
   * cancelled or finished run was read as "still open").
   */
  const OPEN_NODE_RUN_STATUSES = new Set(["in_progress", "todo", "review"]);

  /**
   * Is this card still exactly what `queueAfterRestart`/`reattachOpenRun` read at the
   * top, with nobody else already holding it? `readRun` (and its timeout) takes a
   * while, and in that time the ordinary dispatch (`tick`, independent of this boot
   * reconcile) can relaunch the same card on its own - cancelling `expectedRunId` and
   * creating a new one. Acting on a stale read then would either overwrite the NEW
   * slot with this stale one, or requeue a card another path already owns.
   */
  function stillOursToHandle(taskId: string, expectedRunId: string | null): boolean {
    const fresh = svc.get(taskId)?.task;
    if (!fresh || fresh.status !== "in_progress") return false;
    if (inFlight.has(taskId) || launching.has(taskId)) return false;
    if (expectedRunId !== null && svc.nodeRunOf(taskId) !== expectedRunId) return false;
    return true;
  }

  /**
   * Asks the node whether the run this card had open before the restart is still
   * there, and rebuilds the slot (inside the node's own seats, same as any other
   * launch) instead of queueing over it.
   * - `"reattached"` - the slot is rebuilt, the caller is done.
   * - `"queue"` - the node says the run is gone or closed (or there is no way to ask
   *   it: unpaired, revoked, unreachable, timed out), the caller falls back to the queue.
   * - `"skip"` - a concurrent relaunch already moved this card on, discovered either
   *   before touching the node or after it answered: neither reattaching NOR
   *   queueing is safe, the caller does nothing and leaves the other path alone.
   */
  async function reattachOpenRun(task: Task, runId: string): Promise<"reattached" | "queue" | "skip"> {
    const client = host.client;
    const machineId = task.machineId;
    if (!client || !machineId) return "queue";
    const baseUrl = client.baseUrlOf(machineId);
    const capabilityId = task.delegatedStartCapabilityId ?? null;
    const policy = capabilityId ? host.delegatedPolicyForTask?.(task.id) ?? null : null;
    // THE SAME GUARD `launchOnNode` PUTS BEFORE A TOKEN: an authorization that is gone, or
    // that now names another capability or another machine, must not be used to read the run
    // either. The queue is the honest move here rather than the park `launchOnNode` writes:
    // the tick right after takes the card through that very launch, which parks it with its
    // own reason instead of this path inventing a second wording for it.
    if (capabilityId && (!policy || policy.id !== capabilityId || policy.machineId !== machineId)) return "queue";
    const token = policy
      ? client.delegatedTokenOf?.(machineId, policy.id) ?? null
      : client.tokenOf(machineId);
    if (!baseUrl || !token) return "queue";
    const delegation: NodeRunBinding | undefined = policy ? {
      capabilityId: policy.id,
      subjectPersonId: policy.initiatorPersonId,
      subjectDeviceId: policy.initiatorDeviceId,
    } : undefined;
    let report: NodeRunReport;
    try {
      // A boot reads every orphan ONE AT A TIME (`task-dispatcher-reconcile.ts`):
      // a node that never answers must not hold up every other card behind it.
      report = await withTimeout(client.readRun({ baseUrl, token, runId, delegation }), MIRROR_CANCEL_TIMEOUT_MS);
    } catch (err) {
      log(`nodo: la corsa ${runId} della card ${task.id} non è stata ritrovata dopo il riavvio, la rimetto in coda`, err);
      return "queue";
    }
    if (!OPEN_NODE_RUN_STATUSES.has(report.status)) {
      log(`nodo: la corsa ${runId} della card ${task.id} è chiusa sul nodo (${report.status}), la rimetto in coda`);
      return "queue";
    }
    // ARCHIVED IS NOT IN THE STATUS. The node's board DELETE archives the card and leaves
    // `in_progress` where it was, so an archived run reads as open: reattaching to one keeps
    // the seat for forty polls over work that will never move again, where a restart used to
    // put the card back in the queue.
    if (report.archived) {
      log(`nodo: la corsa ${runId} della card ${task.id} è archiviata sul nodo, la rimetto in coda`);
      return "queue";
    }
    // `report.status === "review"` with a delivery this card ALREADY carries is the exact
    // shape of ff293eda (26/10): the old run's own mirror, not new work to reattach to.
    if (report.status === "review" && report.deliveryCommit && report.deliveryCommit === task.deliveryCommit) return "queue";
    // THE ANCHOR GUARD, which a rebuilt slot would otherwise walk straight past: a card sent
    // back from review carries the tip it was sent back on in `priorCommit`, and a node that
    // still answers with that same delivery is handing back the work that was already
    // refused. Reattaching plants that old branch again after a restart, and only the
    // same-tip bounce stops it. `isPreviousDelivery` is deliberately NOT used here: it would
    // read the legitimate «a real run waiting for its branch» as old too.
    const priorCommit = (svc.get(task.id)?.task ?? task).priorCommit ?? null;
    if (report.status === "review" && report.deliveryCommit && report.deliveryCommit === priorCommit) {
      log(`nodo: la corsa ${runId} della card ${task.id} riporta la consegna già rimandata (${report.deliveryCommit}), la rimetto in coda`);
      return "queue";
    }
    // The readRun above took a while: re-check the card is still exactly where this call
    // left it before touching the slot. A relaunch in the meantime (burial, a human's
    // drag, another restart path) already owns `inFlight`/`launching`, or moved the card,
    // or cancelled/replaced this very run - overwriting its slot would strand that NEW run
    // on the node with nobody polling it (KANBAN-77, the two-deliveries defect in reverse).
    if (!stillOursToHandle(task.id, runId)) return "skip";
    host.beginRun(task.id, nodeSessionKey(machineId, runId));
    const slot = inFlight.get(task.id);
    if (!slot) return "skip";
    // `primed: true` and a `seen` seeded with only the node's own "mirrored from
    // us" note (the one `primed: false` swallows whole on a fresh launch, when it
    // is the only comment there) - the first poll after reattach mirrors every
    // comment written on the node WHILE THIS SERVER WAS DOWN instead of silently
    // adopting them as already-seen and losing them for good (export-morti-2,
    // 22/11: its summary and delivery line never made it back).
    const seen = new Set<string>();
    const mirrorNote = report.comments.find((c) => c.kind === "service" && c.content.startsWith("Card specchiata da "));
    if (mirrorNote) seen.add(mirrorNote.id);
    slot.node = { machineId, baseUrl, token, runId, fails: 0, seen, primed: true, ...(delegation ? { delegation } : {}) };
    return "reattached";
  }

  /**
   * The run of a card that is already done. The cancel is best effort: a node
   * that cannot be reached must not keep the slot forever, and a late report is
   * harmless now that a done card ignores system deliveries.
   */
  async function retireDoneRun(taskId: string, node: NodeSlot): Promise<void> {
    const client = host.client;
    if (client) {
      try {
        await client.cancelRun({ baseUrl: node.baseUrl, token: node.token, runId: node.runId, delegation: node.delegation });
      } catch (err) { log(`node: run ${node.runId} of the done card ${taskId} was not cancelled`, err); }
    }
    inFlight.delete(taskId);
    lastNodeRun.delete(taskId);
    try { releaseAndEmit({ taskId, requeue: false }); }
    catch (err) { log(`node: done card ${taskId} was not released`, err); }
  }

  /**
   * Mirrors left open on the node by cards that left the cycle (done or archived) after their run
   * came home. `landNodeDelivery` closes the slot here, and nothing else archived the mirror over
   * there: it stayed in review and the node GC kept its worktree forever (16/11, 145 worktrees on
   * the PC, disk under the dispatch floor). The cancel archives the node card, the branch stays
   * pinned there. Best effort and idempotent: a silent node is retried next round, a 404 is done.
   * A card in review here is NOT retired: a review sent back resumes from the branch.
   */
  let mirrorSweep: Promise<void> | null = null;
  async function retireClosedMirrors(): Promise<void> {
    const client = host.client;
    // One failed node is skipped for the rest of the round: 39 cancels to a dead PC would
    // otherwise each wait for the network to give up.
    const silent = new Set<string>();
    if (!client || !svc.retiredNodeRuns) return;
    let rows: ReturnType<NonNullable<TaskService["retiredNodeRuns"]>>;
    try { rows = svc.retiredNodeRuns(); } catch (err) { log("node: retired mirrors not read", err); return; }
    for (const row of rows) {
      // A live slot belongs to retireDoneRun or the restart path, not to this sweep.
      if (inFlight.has(row.taskId) || launching.has(row.taskId)) continue;
      if (!row.machineId) { lastNodeRun.delete(row.taskId); continue; }
      if (silent.has(row.machineId)) continue;
      const baseUrl = client.baseUrlOf(row.machineId);
      const policy = row.capabilityId ? host.delegatedPolicyForTask?.(row.taskId) ?? null : null;
      const token = policy
        ? client.delegatedTokenOf?.(row.machineId, policy.id) ?? client.tokenOf(row.machineId)
        : client.tokenOf(row.machineId);
      if (!baseUrl || !token) continue;
      try {
        await withTimeout(client.cancelRun({
          baseUrl, token, runId: row.runId,
          delegation: policy ? {
            capabilityId: policy.id,
            subjectPersonId: policy.initiatorPersonId,
            subjectDeviceId: policy.initiatorDeviceId,
          } : undefined,
        }), MIRROR_CANCEL_TIMEOUT_MS);
      } catch (err) {
        if (!(isNodeError(err) && err.status === 404)) {
          silent.add(row.machineId);
          log(`node: mirror of run ${row.runId} (card ${row.taskId}) not archived, retrying next round`, err);
          continue;
        }
      }
      // Only clear the id that was cancelled: a new dispatch may have written another meanwhile.
      if (lastNodeRun.get(row.taskId) === row.runId) lastNodeRun.delete(row.taskId);
    }
  }

  async function cancelTask(taskId: string): Promise<boolean | null> {
    const slot = inFlight.get(taskId);
    const node = slot?.node;
    const client = host.client;
    if (!slot || !node || !client) return null;
    try {
      await client.cancelRun({
        baseUrl: node.baseUrl,
        token: node.token,
        runId: node.runId,
        delegation: node.delegation,
      });
    } catch (err) {
      log(`node: delegated run ${node.runId} cancellation failed`, err);
      try {
        emit(svc.setDispatchState({
          taskId,
          state: CHIP_BLOCKED,
          error: "delegated_cancel_unconfirmed",
        }));
      } catch { /* the persisted authority is still closed */ }
      return false;
    }
    inFlight.delete(taskId);
    lastNodeRun.delete(taskId);
    try {
      releaseAndEmit({
        taskId,
        requeue: false,
        rollbackAttempt: true,
        parkState: CHIP_BLOCKED,
        reason: node.cancelReason === "audit_binding_failed"
          ? "Remote run audit binding failed; cancellation is now confirmed."
          : "Delegated start authorization was revoked.",
      });
      if (node.delegation) {
        try { host.recordDelegatedPhase?.({ taskId, phase: "cancelled", outcome: "capability_revoked" }); }
        catch { /* audit never opens authority */ }
      }
    } catch (err) {
      log(`node: delegated card ${taskId} was not released after cancellation`, err);
    }
    return true;
  }

  return { remoteLaunch, sweepVerdict, buryRun, poll, queueAfterRestart, cancelTask };
}
