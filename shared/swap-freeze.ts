/**
 * THE ONE SHAPE AND THE FIVE NUMBERS OF THE SWAP FREEZE, shared by the server
 * that decides it and the client that draws the frost.
 *
 * WHAT A SIGSTOP BUYS, said once. It gives NO memory back - that is why the
 * memory freeze of `shared/machine-budget.ts` was withdrawn and why
 * `proposal.md` lists "a brake that freezes the agents" as a non-goal. What it
 * does buy is that a stopped tree touches no page: its pages age out once and
 * are then left alone, so it stops evicting everybody else's working set. That
 * is a hypothesis about this machine and not a fact, so every freeze measures
 * its own effect and one that shows none is undone (`no effect`, below).
 *
 * WHY THE FLOOR IS 0.5 GB. It is not tuned to the 15/09 incident, whose command
 * size was never measured (the "658 MB" of that evening was the whole pane tree,
 * the `claude` CLI included, and the CLI alone held 343 MB). It is the line
 * under which freezing frees nothing worth the cost: measured in CI on
 * 16/09/2026 (T0 probe, macOS runner) ONE headless WebKit page running a WebGL
 * loop weighs 0.057 GB of command tree plus 0.383 GB of WebKit XPC services =
 * 0.44 GB, and stays under the floor on purpose. The battery of 15/09 drove
 * several pages at once. Whether real agent trees on this Mac ever reach the
 * floor is reported by E0 of the bar, not guessed here.
 */

/** One frozen tree, as every surface of the client draws it. */
export interface SwapFreezeView {
  /** `treeId`: stable for the life of the freeze, and the seed of the frost. */
  id: string;
  sessionKey: string;
  topicId: string | null;
  /** PTY session id when the tree hangs off a pane; `null` for a chat. */
  terminalId: string | null;
  /** The card this session works on, when there is one. */
  taskId: string | null;
  /** The root's command, shortened for a label. */
  command: string;
  footprintGB: number;
  pagesReadBackPerS: number | null;
  debtGBPerMin: number | null;
  frozenAt: number;
  /** `frozenAt + FREEZE_MAX_MS`: the latest a thaw can come. */
  thawBy: number;
  /** Which of the two freezes this tree is allowed this is. */
  n: number;
}

/**
 * Under this a freeze frees no page activity worth its cost. See the header for
 * the T0 measurement that fixes it, and E0 of the bar for whether this Mac's own
 * agent trees ever reach it.
 */
export const FREEZE_MIN_GB = 0.5;
/**
 * And it has to be BURNING something. An idle 2 GB background process can be the
 * heaviest tree on the machine, and stopping it stops no page activity at all.
 */
export const FREEZE_MIN_CORES = 0.1;
/**
 * Ten minutes, the same wall a gate slot fails open at (`scripts/gate-slot.ts`):
 * what a frozen tree holds - a slot, a `git index.lock`, an open transaction,
 * an agent's turn waiting on `BashOutput` - is bounded by this and by nothing
 * else.
 */
export const FREEZE_MAX_MS = 600_000;
/** After two, the same tree runs to the end: a third would be a kill in instalments. */
export const FREEZES_PER_TREE = 2;
/** A freeze whose swap-in rate stays this close to its own starting value bought nothing. */
export const NO_EFFECT_RATIO = 0.8;
/** The window in which the effect is read: earlier is noise, later is the `max` rule's business. */
export const NO_EFFECT_FROM_MS = 120_000;
export const NO_EFFECT_TO_MS = 180_000;
/**
 * One swap action per window, shared with the check brake
 * (`SWAP_INTERRUPT_SPACING_MS`): two levers acting on the same reading would
 * each be measuring the other's effect.
 */
export const SWAP_ACTION_SPACING_MS = 120_000;
/** The thaw-on-room floor: the same 6 GB the checks waiter calls room. */
export const FREEZE_ROOM_FLOOR_GB = 6;

/** Why a tree was continued. The log line and the notification carry it. */
export type ThawReason = "room" | "no effect" | "max" | "owner gone" | "shutdown" | "boot";
