/**
 * OVERFLOW DISPATCH: a card held by THIS machine's memory floor goes to another
 * machine instead of waiting for hours.
 *
 * The floor (`dispatch-capacity.ts`) answers "can THIS Mac take one more agent",
 * and a card that runs on a paired node or on Cloud Claude does not answer to it
 * (`isRemoteTask` in the dispatcher). So while the Mac reads under its line, a
 * card that could run elsewhere is waiting for memory it does not need. On
 * 26/10/2026 eight cards moved by hand (PATCH `machineId`) went from 1 to 9 at
 * work in one minute; on 30/10 three cards sat still for the same reason with
 * the PC and the cloud online.
 *
 * WHAT MOVES: a card that would run here (no machine, or this machine's own
 * row - the board default meaning "here", chosen by hand or not: the row does
 * not say which) and has been held by the memory floor
 * for more than `OVERFLOW_AFTER_MS`, in consecutive rounds. WHAT STAYS: a card or
 * a board explicitly marked "this Mac only" (`stayLocal` / `dispatchStayLocal`) -
 * local processes, OpenClaw, sessions, macOS. A mark and not a guess on the
 * text: a heuristic that sends a macOS card to the cloud fails over there,
 * after the wait. Also a delegated card, a node's mirror card and a card with
 * uncommitted work: their run is bound to this machine (`overflowEligible`).
 *
 * WHERE: Cloud Claude while the Claude plan has credit (no provider hold), the
 * project's origin is on GitHub (the only host a cloud session clones from) and
 * the card's model is a Claude one (the cloud has no other); otherwise the first
 * online paired node, and failing that a SLEEPING one this machine can wake (a
 * `node-run` hook is declared): the remote lane runs that hook before the run,
 * the same path a person's choice takes. A PC asleep goes offline five minutes
 * after its last heartbeat, and refusing it left the card on the full Mac, the
 * very problem this file exists for. A machine already carrying its share
 * (`OVERFLOW_SLOTS`, counted on every live card that names it, not only on the
 * runs alive here) takes nothing more, and one round moves at most
 * `OVERFLOW_MAX_PER_ROUND` cards: a full Mac must not empty its queue onto a PC
 * that has its own floor.
 *
 * A card that already has a branch (`carriedBranch`: its delivery branch, or
 * the `prior_branch` kept when a review sent it back to the queue) carries it:
 * the remote run starts FROM that branch, pushed to origin first. A branch that
 * cannot reach origin keeps the card here (`overflowBranchReady`).
 */

/** How long a card waits behind the memory floor before it moves (the floor's own window). */
export const OVERFLOW_AFTER_MS = 2 * 60_000;

/**
 * How many overflowed or hand-sent cards a machine runs at once before the
 * overflow stops adding: no node declares a capacity yet, so this is the
 * declaration. `slots` on the machine overrides it.
 */
export const OVERFLOW_SLOTS: Readonly<Record<OverflowMachine["kind"], number>> = { cloud: 4, node: 2 };

/** How many cards a single round may move, all machines together. */
export const OVERFLOW_MAX_PER_ROUND = 2;

/** A machine the overflow can send a card to: never this one. */
export interface OverflowMachine {
  id: string;
  /** For the line a person reads ("moved to Cloud Claude: Mac full"). */
  name: string;
  /** `cloud` = the Claude cloud row, `node` = a paired computer (the PC). */
  kind: "cloud" | "node";
  /** The heartbeat's verdict. Cloud: online or never chosen. */
  online: boolean;
  /** A node only: offline, but the `node-run` hook wakes it before the run. */
  wakeable?: boolean;
  /** The machine's declared capacity, when it has one (default `OVERFLOW_SLOTS[kind]`). */
  slots?: number;
}

/** What the overflow knows about one card when it chooses where to send it. */
export interface OverflowChoice {
  /** The Claude plan has credit (no provider hold). */
  cloudCredit: boolean;
  /** The project's origin is a GitHub repository: the cloud clones nothing else. */
  githubOrigin: boolean;
  /** The card's model, or the board's: the cloud runs only Claude models. */
  model: string | null;
  /** Live cards on that machine (Todo or in progress, this round's moves included). */
  load: (machineId: string) => number;
}

/**
 * Does the cloud run this model? Empty = the cloud's own default (a Claude
 * one); otherwise a Claude alias or a `claude-*` id, provider prefix allowed.
 * `cloudModelFor` falls back to Claude in silence for anything else: a Codex
 * card sent there would run on another model than the one it asked for.
 */
export function cloudRunsModel(selection: string | null | undefined): boolean {
  const chosen = (selection ?? "").trim().toLowerCase();
  if (!chosen) return true;
  const parts = chosen.split(":");
  const model = parts.at(-1)!.trim();
  const provider = parts.length > 1 ? parts[0]!.trim() : "";
  if (provider && !provider.startsWith("claude")) return false;
  return !model || model === "opus" || model === "sonnet" || model === "haiku" || model.startsWith("claude-");
}

/**
 * The machine a held card goes to, or `null` when there is none. Cloud first
 * when it can take this card (credit, a GitHub origin, a Claude model: it needs
 * nobody and nothing to wake), then the first online node in the order given
 * (the store lists the freshest heartbeat first), then the first sleeping node
 * that can be woken. A machine at its slots is skipped.
 */
export function pickOverflowMachine(
  machines: readonly OverflowMachine[],
  opts: OverflowChoice,
): OverflowMachine | null {
  const room = (m: OverflowMachine) => opts.load(m.id) < (m.slots ?? OVERFLOW_SLOTS[m.kind]);
  const online = machines.filter((m) => m.online && room(m));
  if (opts.cloudCredit && opts.githubOrigin && cloudRunsModel(opts.model)) {
    const cloud = online.find((m) => m.kind === "cloud");
    if (cloud) return cloud;
  }
  return online.find((m) => m.kind === "node")
    ?? machines.find((m) => m.kind === "node" && !m.online && m.wakeable && room(m))
    ?? null;
}

/** The idempotency key of a node's MIRROR card (`routes/nodes.ts`): it already runs where its origin sent it. */
const MIRROR_KEY_PREFIX = "node-run:";

/**
 * Whether a card may leave this machine at all, before any clock: the board's
 * switch, the two "this Mac only" marks, where the card runs today, and the
 * three cards whose run is bound to this machine:
 *  - a DELEGATED card: its authority names this machine (`policy.machineId`),
 *    and over there it would be parked as no longer valid;
 *  - a MIRROR card (`node-run:`): this machine is already the node another
 *    one sent it to, and sending it on would hand a third machine a run the
 *    origin is polling here;
 *  - a card with work never committed (`deliveryUncommittedFiles`, or
 *    `priorUncommittedFiles` once a review sent it back to the queue): what is
 *    not committed cannot be pushed, so the run over there would start without it;
 *  - a PLAN-FIRST card (`planFirst`): the "plan first, implement nothing"
 *    instruction is written only into the local prompt, and `CreateRunBody`
 *    does not carry it, so over there it would be implemented without an
 *    approved plan. Those cards stay here (decision of 31/10/2026).
 */
export function overflowEligible(
  task: {
    machineId: string | null;
    stayLocal?: boolean;
    delegated?: boolean;
    claudeTaskId?: string | null;
    deliveryUncommittedFiles?: number | null;
    priorUncommittedFiles?: number | null;
    planFirst?: boolean;
  },
  board: { dispatchOverflow?: boolean; dispatchStayLocal?: boolean },
  localMachineId: string | null,
): boolean {
  if (board.dispatchOverflow === false || board.dispatchStayLocal) return false;
  if (task.stayLocal || task.delegated || task.planFirst) return false;
  if (task.claudeTaskId?.startsWith(MIRROR_KEY_PREFIX)) return false;
  if ((task.deliveryUncommittedFiles ?? 0) > 0 || (task.priorUncommittedFiles ?? 0) > 0) return false;
  return task.machineId == null || (localMachineId != null && task.machineId === localMachineId);
}

/** The one line on the card and in the thread: where it went and why. */
export function overflowNote(machineName: string): string {
  return `Spostata su ${machineName}: Mac pieno. La memoria di questa macchina è rimasta sotto il pavimento per più di 2 minuti, ` +
    `e lì il pavimento non vale. Per tenerla sul Mac segnala «solo Mac» sulla card o sulla board: ` +
    `scegliere a mano questo Mac come macchina non basta, vale come la macchina predefinita.`;
}

/** What the overflow reads of one row of the machine store. */
export interface OverflowMachineRow {
  id: string;
  name: string;
  baseUrl: string | null;
  status: string;
}

/**
 * THE WIRING of `DispatcherDeps.overflowMachines` (server.ts): the store's rows
 * with an address, as overflow targets. The cloud row has no heartbeat of its
 * own: it is online only while the cloud is enabled here, its row says so and
 * the account has an active cloud environment (`environmentOk` false = known to
 * have none; `null` = not asked yet). A paired node is online by its heartbeat,
 * and a sleeping one is wakeable while a `node-run` hook is declared.
 */
export function overflowMachinesFrom(input: {
  rows: readonly OverflowMachineRow[];
  isCloud: (baseUrl: string) => boolean;
  cloudEnabled: boolean;
  environmentOk: boolean | null;
  wakeable: boolean;
}): OverflowMachine[] {
  const out: OverflowMachine[] = [];
  for (const m of input.rows) {
    if (!m.baseUrl) continue;
    out.push(input.isCloud(m.baseUrl)
      ? { id: m.id, name: m.name, kind: "cloud", online: input.cloudEnabled && m.status === "online" && input.environmentOk !== false }
      : { id: m.id, name: m.name, kind: "node", online: m.status === "online", wakeable: input.wakeable });
  }
  return out;
}

/**
 * THE WIRING of `DispatcherDeps.githubOriginOf` (server.ts): the project's
 * origin resolves to a GitHub `owner/repo`. No origin, or a lookup that throws,
 * is "no": Cloud is then never chosen for it.
 */
export async function githubOriginFrom(
  origin: string | null,
  resolveSlug: (origin: string) => Promise<string | null> | string | null,
): Promise<boolean> {
  if (!origin) return false;
  try { return !!(await resolveSlug(origin)); } catch { return false; }
}
