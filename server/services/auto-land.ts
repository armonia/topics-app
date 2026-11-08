/**
 * THE CARD THAT NEEDS NO ONE LANDS ITSELF.
 *
 * `whoCloses` (shared/task-labels.ts) has said `conductor` since 11/08 for a
 * card labelled `invisibile` whose bar is green, and nothing ever executed it:
 * the chip on the card was the only reader. Measured on 08/11, 27 cards sat in
 * review, 2 of them with a green bar, and the board's owner was the only way out.
 *
 * This module is the verdict, pure and testable without a repo. The router runs
 * it after a delivery and lands the card when it says `ok`. Every refusal
 * carries a reason in English for the log; the card stays in review and a person
 * decides, which is the safe direction.
 *
 * The verdict keeps the five protections the old manual gesture gave (found in
 * the git history of the land, see docs/board-protocol.md section 8):
 *   1. code that never reached main        -> the land itself, which only closes
 *      a card once main re-read confirms the merge (not decided here);
 *   2. an agent still at work on the card  -> the land cuts the turn (not here);
 *   3. a land that realigns the branch and merges a commit other than the one
 *      measured                            -> `commitMeasured` below, and the
 *      land is asked not to realign (`DeliverySnapshot.noRealign`);
 *   4. a green card with a red e2e on main -> the bar must be the board's whole
 *      declared bar, and it is measured on the commit that will land;
 *   5. plans with no diff closing alone    -> a delivery commit is required.
 *
 * Two more, from the review of this very module:
 *   6. a text or an effect no label shows  -> `needsAPerson(files)`: the label
 *      `invisibile` is "not under client/src", which also holds push
 *      notifications, Discord presence, the shell and the migrations;
 *   7. a partial delivery or a spoken word -> a card with a dispatch error, or
 *      with a person's comment after it entered review, is a person's to close.
 */
import { STAGE_AI_REVIEW, agentAskInThread } from "../../shared/workflow";
import { whoCloses } from "../../shared/task-labels";
import { commentAuthorLabel } from "../../shared/comment-author";
import { isThreadSpeech, type CheckRun } from "../../shared/board";

/** What the verdict reads off the card, and nothing else. */
export interface AutoLandCard {
  status: string;
  archived?: boolean;
  labels: ReadonlyArray<{ label: string }>;
  checksState: "running" | "pass" | "fail" | "unknown" | null;
  checksCommit: string | null;
  checks: ReadonlyArray<Pick<CheckRun, "ok">> | null;
  deliveryBranch: string | null;
  deliveryCommit: string | null;
  humanAsk?: string | null;
  /** A run that ended on an error (a quota stop with half a commit): never a clean delivery. */
  dispatchError?: string | null;
  /** When the card entered review; a person's comment after it is read as a word on THIS delivery. */
  reviewAt?: string | null;
  /** A card in AI review is closed by whoever opened it: the opener's gesture, not ours. */
  stage?: string | null;
  /** Direct steps still open: closing the parent would leave them unreachable. */
  subtaskCount?: number;
  subtaskDoneCount?: number;
}

export interface AutoLandBoard {
  /** The board's "merge on Done" switch. */
  autoMerge: boolean;
  /** How many commands the board declares in its bar. */
  declaredChecks: number;
}

export interface AutoLandComment {
  author?: string | null;
  content: string;
  kind?: string | null;
  createdAt?: string | null;
  quiet?: boolean | null;
}

type AutoLandVerdict = { ok: true } | { ok: false; reason: string };

/** Same commit, whether one side is abbreviated or not. */
export function sameCommit(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a ?? "").trim().toLowerCase();
  const y = (b ?? "").trim().toLowerCase();
  if (x.length < 7 || y.length < 7) return false;
  return x.startsWith(y) || y.startsWith(x);
}

export function autoLandVerdict(
  card: AutoLandCard,
  board: AutoLandBoard,
  thread: ReadonlyArray<AutoLandComment>,
): AutoLandVerdict {
  const no = (reason: string): AutoLandVerdict => ({ ok: false, reason });
  if (card.status !== "review" || card.archived) return no("the card is not in review");
  if (!board.autoMerge) return no("the board's automatic merge is off");
  // A board with no bar has nothing that could be green: `null` is not a pass.
  if (board.declaredChecks < 1) return no("the board declares no bar");
  const labels = card.labels.map((l) => l.label);
  if (whoCloses(labels, card.checksState) !== "conductor") return no("the card is not invisible with a green bar");
  // "Whole": every command the board declares has a row, and every row is ok.
  const runs = card.checks ?? [];
  if (runs.length < board.declaredChecks || !runs.every((r) => r.ok)) return no("the bar is not green in full");
  if (!card.deliveryBranch || !card.deliveryCommit) return no("the delivery has no branch and commit of its own");
  // The bar must describe what is about to land, not an earlier round.
  if (!sameCommit(card.checksCommit, card.deliveryCommit)) return no("the bar measured another commit than the delivered one");
  if (card.stage === STAGE_AI_REVIEW) return no("the card is in AI review, its opener closes it");
  if ((card.humanAsk ?? "").trim()) return no("the card asks the person something");
  if ((card.dispatchError ?? "").trim()) return no("the run ended on an error: the delivery may be partial");
  if (personSpokeSinceReview(card.reviewAt ?? null, thread)) return no("a person wrote on the card after it entered review");
  if (agentAskInThread(thread)) return no("the agent's last word is a question");
  if ((card.subtaskCount ?? 0) > (card.subtaskDoneCount ?? 0)) return no("the card still has open steps");
  return { ok: true };
}

/**
 * A person's word on the card since it entered review ("do not land", a
 * question, an "ok, but"): whoever wrote it is waiting for an answer, not for a
 * merge. A `quiet` note is the one gesture that says "not addressed to the agent".
 * With no review stamp, only a person speaking LAST counts.
 */
function personSpokeSinceReview(reviewAt: string | null, thread: ReadonlyArray<AutoLandComment>): boolean {
  const byPerson = (c: AutoLandComment) => {
    const who = commentAuthorLabel(c.author).kind;
    return isThreadSpeech(c) && !c.quiet && (who === "user" || who === "guest");
  };
  if (reviewAt) return thread.some((c) => byPerson(c) && !!c.createdAt && c.createdAt >= reviewAt);
  for (let i = thread.length - 1; i >= 0; i--) {
    const c = thread[i]!;
    if (!isThreadSpeech(c)) continue;
    const who = commentAuthorLabel(c.author).kind;
    if (who === "system" || who === "dispatcher" || who === "verifier") continue;
    return byPerson(c);
  }
  return false;
}

/**
 * Paths whose change a person must look at even when the label says `invisibile`
 * (that label only means "not under client/src"). Each one is an effect the diff
 * shows no UI for: a message that reaches a person's phone or a channel, a text
 * a view or the chat renders, the desktop shell, the migrations that run on the
 * live database the moment they land, what publishes a release, money and licences.
 * Test files alone never count: they change no behaviour.
 */
const NEEDS_A_PERSON: readonly RegExp[] = [
  /^desktop-tauri\//,
  /^\.github\//,
  /^server\/db\/migrations\//,
  /^server\/views\//,
  /^shared\/(i18n|tool-detail|presence-phrase|notify-actions|licenza-motivi)/,
  /^server\/routes\/(agent-channels|billing|license|notifications|push)/,
  /^server\/services\/(discord|dispatch-budget-message)/,
  /^server\/lib\/(stripe|licenza)/,
  // Anything else under server/ or shared/ named for a channel to a person.
  /^(server|shared)\/.*(push|discord|presence|notif|stripe|billing|licen[sz]|webhook|mailer|email|telegram|whatsapp|slack)/i,
];

/** The files of a delivery a person must look at; empty = none. */
export function needsAPerson(files: readonly string[]): string[] {
  return files.filter((f) => !/\.test\.[jt]sx?$/.test(f) && !f.startsWith("tests/") && NEEDS_A_PERSON.some((re) => re.test(f)));
}

/** Does a diff reload the live server when it lands? Conservative: `shared/` counts. */
export function touchesServer(files: readonly string[] | null): boolean {
  // `null` = unknown, and the careful reading of unknown is "it does".
  if (files === null) return true;
  return files.some((f) => f.startsWith("server/") || f === "server.ts" || f.startsWith("shared/"));
}

/** What the runner needs from the router; every name is the router's own door. */
interface AutoLanderDeps {
  read(taskId: string, projectId: string): { task: AutoLandCard & { id: string; projectId: string }; comments: ReadonlyArray<AutoLandComment> } | undefined;
  board(projectId: string): AutoLandBoard;
  /** Queue the land (the router's `enqueueLand`), asking it NOT to realign the branch. */
  land(projectId: string, taskId: string): unknown;
  note(taskId: string, text: string): void;
  /** Files of the delivered branch; `null` = unknown, and a land that does not know what it changes does not happen. */
  files?: (taskId: string) => Promise<string[] | null>;
  /** Agent and chat turns open right now on this server. */
  liveTurns?: () => number;
  /**
   * Is the CARD'S OWN agent still in a turn? Landing cuts that turn
   * (`cutLiveTurn`), and an agent moves its card to review in the middle of a
   * turn: a question it writes right after would be cut before anyone read it.
   */
  cardTurnLive?: (taskId: string) => boolean;
  pollMs?: number;
  maxWaitMs?: number;
  log?: (line: string) => void;
}

type AutoLandOutcome = "queued" | "waiting" | "refused";

/**
 * Lands the card when the verdict allows it. A diff that reloads the live
 * server waits for ZERO open turns first: the land runs in the checkout the
 * server runs from, and the watcher reloads on the merge, which cuts every turn
 * in flight (task-automerge.ts, "the shared checkout is ALREADY on main").
 * The wait is a timer in this process: a reload loses it, which is why the
 * router also offers `sweep` and the host calls it after a boot.
 */
export function createAutoLander(deps: AutoLanderDeps) {
  const waiting = new Set<string>();
  /** Cards between "the verdict said yes" and "the land is queued": a second ask in that gap is the same ask. */
  const deciding = new Set<string>();
  /**
   * The commit already handed to the land queue, per card. A land that comes
   * back `skipped` leaves the card in review with a green bar, so the verdict
   * would say yes again at every sweep: one land per ten minutes, forever, for
   * a refusal that cannot change until the branch does.
   */
  const attempted = new Map<string, string>();
  const log = deps.log ?? (() => undefined);
  const pollMs = deps.pollMs ?? 15_000;
  const maxWaitMs = deps.maxWaitMs ?? 3 * 60 * 60_000;

  function verdictNow(projectId: string, taskId: string): AutoLandVerdict {
    let got: ReturnType<AutoLanderDeps["read"]>;
    let board: AutoLandBoard;
    try { got = deps.read(taskId, projectId); board = deps.board(projectId); }
    // Unreadable settings must not land "because we did not know".
    catch { return { ok: false, reason: "the card or its board could not be read" }; }
    if (!got) return { ok: false, reason: "the card is gone" };
    return autoLandVerdict(got.task, board, got.comments);
  }

  function landNow(projectId: string, taskId: string): void {
    const got = deps.read(taskId, projectId);
    const commit = got?.task.deliveryCommit ?? "";
    attempted.set(taskId, commit);
    try {
      deps.note(
        taskId,
        `Atterrata da sola: la barra della board è verde per intero sul commit consegnato (\`${commit.slice(0, 8)}\`), la card è invisibile ` +
          "e non fa domande. Si chiude solo a merge confermato su main; se il ramo si è mosso o è rimasto indietro non lo tocco e resta in review.",
      );
    } catch (err) { log(`[auto-land] nota non scritta per ${taskId}: ${String(err)}`); }
    deps.land(projectId, taskId);
  }

  /** `quiet`: the periodic sweep asks about the same refused cards every round, and says nothing about them. */
  async function tryLand(projectId: string, taskId: string, how: { quiet?: boolean } = {}): Promise<AutoLandOutcome> {
    const refuse = (why: string): AutoLandOutcome => {
      if (!how.quiet) log(`[auto-land] ${taskId.slice(0, 8)} resta in review: ${why}`);
      return "refused";
    };
    const first = verdictNow(projectId, taskId);
    if (!first.ok) return refuse(first.reason);
    if (waiting.has(taskId) || deciding.has(taskId)) return "waiting";
    if (attempted.get(taskId) === deps.read(taskId, projectId)?.task.deliveryCommit) return refuse("this commit was already offered to the land");
    deciding.add(taskId);
    try {
      let files: string[] | null = null;
      try { files = deps.files ? await deps.files(taskId) : null; } catch { files = null; }
      // A land that cannot say what it changes does not happen: the paths are the only reading of "a person must look".
      if (files === null) return refuse("the files of the delivery could not be read");
      const heavy = needsAPerson(files);
      if (heavy.length > 0) return refuse(`the delivery touches what a person must look at (${heavy.slice(0, 3).join(", ")})`);
      const serverLand = touchesServer(files);
      // The card's own turn must be over whatever the diff: landing cuts it.
      const mustWait = () =>
        (deps.cardTurnLive?.(taskId) ?? false) || (serverLand && !!deps.liveTurns && deps.liveTurns() > 0);
      if (!mustWait()) {
        landNow(projectId, taskId);
        return "queued";
      }
      waiting.add(taskId);
      const startedAt = Date.now();
      const timer = setInterval(() => {
        // Asked again at every beat: a person may have closed the card, or the agent asked something, meanwhile.
        const again = verdictNow(projectId, taskId);
        const expired = Date.now() - startedAt > maxWaitMs;
        if (!again.ok || expired) {
          clearInterval(timer); waiting.delete(taskId);
          log(`[auto-land] ${taskId.slice(0, 8)} non atterra piu': ${again.ok ? "attesa dei turni scaduta" : again.reason}`);
          return;
        }
        if (mustWait()) return;
        clearInterval(timer); waiting.delete(taskId);
        landNow(projectId, taskId);
      }, pollMs);
      (timer as { unref?: () => void }).unref?.();
      return "waiting";
    } finally {
      deciding.delete(taskId);
    }
  }

  /** Cards no longer in review start clean: a card sent back and delivered again at the same commit is asked again. */
  function forgetExcept(inReview: ReadonlySet<string>): void {
    for (const id of [...attempted.keys()]) if (!inReview.has(id)) attempted.delete(id);
  }

  return { tryLand, forgetExcept, isWaiting: (taskId: string) => waiting.has(taskId) };
}
