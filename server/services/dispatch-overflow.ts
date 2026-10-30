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
 * row - the board default meaning "here") and has been held by the memory floor
 * for more than `OVERFLOW_AFTER_MS`. WHAT STAYS: a card or a board explicitly
 * marked "this Mac only" (`stayLocal` / `dispatchStayLocal`) - local processes,
 * OpenClaw, sessions, macOS. A mark and not a guess on the text: a heuristic
 * that sends a macOS card to the cloud fails over there, after the wait.
 *
 * WHERE: Cloud Claude while the Claude plan has credit (no provider hold), the
 * project's origin is on GitHub (the only host a cloud session clones from) and
 * the card's model is a Claude one (the cloud has no other); otherwise the first
 * online paired node. The remote lane's `node-run` hook wakes it before the run,
 * the same path a person's choice takes. A machine already carrying its share
 * (`OVERFLOW_SLOTS`) takes nothing more, and one round moves at most
 * `OVERFLOW_MAX_PER_ROUND` cards: a full Mac must not empty its queue onto a PC
 * that has its own floor.
 *
 * A card that already has a delivery branch (sent back after a review) carries
 * it: the remote run starts FROM that branch, pushed to origin first. A branch
 * that cannot reach origin keeps the card here (`deliveryBranchReady`).
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
  /** For the line a person reads («Spostata su Cloud Claude: Mac pieno»). */
  name: string;
  /** `cloud` = the Claude cloud row, `node` = a paired computer (the PC). */
  kind: "cloud" | "node";
  /** The heartbeat's verdict: an offline machine is never chosen. */
  online: boolean;
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
  /** Remote runs live on that machine right now (this round's moves included). */
  load: (machineId: string) => number;
}

/**
 * Does the cloud run this model? Empty = the cloud's own default (a Claude
 * one); otherwise a Claude alias or a `claude-*` id, provider prefix allowed.
 * `cloudModelFor` falls back to Claude in silence for anything else: a Codex
 * card sent there would run on another model than the one it asked for.
 */
export function cloudRunsModel(selection: string | null | undefined): boolean {
  const sel = (selection ?? "").trim().toLowerCase();
  if (!sel) return true;
  const parts = sel.split(":");
  const model = parts.at(-1)!.trim();
  const provider = parts.length > 1 ? parts[0]!.trim() : "";
  if (provider && !provider.startsWith("claude")) return false;
  return !model || model === "opus" || model === "sonnet" || model === "haiku" || model.startsWith("claude-");
}

/**
 * The machine a held card goes to, or `null` when there is none. Cloud first
 * when it can take this card (credit, a GitHub origin, a Claude model: it needs
 * nobody and nothing to wake), then the first online node in the order given
 * (the store lists the freshest heartbeat first). A machine at its slots is skipped.
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
  return online.find((m) => m.kind === "node") ?? null;
}

/**
 * Whether a card may leave this machine at all, before any clock: the board's
 * switch, the two "this Mac only" marks, and where the card runs today.
 */
export function overflowEligible(
  task: { machineId: string | null; stayLocal?: boolean },
  board: { dispatchOverflow?: boolean; dispatchStayLocal?: boolean },
  localMachineId: string | null,
): boolean {
  if (board.dispatchOverflow === false || board.dispatchStayLocal) return false;
  if (task.stayLocal) return false;
  return task.machineId == null || (localMachineId != null && task.machineId === localMachineId);
}

/** The one line on the card and in the thread: where it went and why. */
export function overflowNote(machineName: string): string {
  return `Spostata su ${machineName}: Mac pieno. La memoria di questa macchina è rimasta sotto il pavimento per più di 2 minuti, ` +
    `e lì il pavimento non vale. Per tenerla sul Mac segnala «solo Mac», o rimetti la macchina a mano.`;
}
