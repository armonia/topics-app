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
 * More, from the reviews of this very module:
 *   6. a text or an effect no label shows  -> `classifyDelivery(files)`: the label
 *      `invisibile` is "not under client/src", which also holds push
 *      notifications, Discord presence, the shell and the migrations;
 *   7. a partial delivery or a spoken word -> a card with a dispatch error, or
 *      with a person's comment after it entered review, is a person's to close;
 *   8. a verdict that outlives its facts    -> card, files and turns are read
 *      again at every beat of the wait AND, inside the repo's queue, a moment
 *      before the merge itself (`recheck`, asked as `DeliverySnapshot.beforeMerge`),
 *      because the wait lasts hours and the queue and the fetch minutes.
 *   9. a list of words cannot say that a file is harmless: 242 files of
 *      `server/lib|services|utils` passed the vocabulary net, among them the one
 *      that builds the agents' environment, the one that runs the bar and the one
 *      that sets the restart gate. So only TEXT AND TESTS land alone (`docs/`,
 *      `openspec/`, test files); server code needs the board's AI review to have
 *      approved THIS commit (`aiReviewVerdict`), and everything else is a person's.
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
  /** The session that works the card and the model the card asked for: who WROTE it, for the AI-review gate. */
  assignedTopicId?: string | null;
  model?: string | null;
}

export interface AutoLandBoard {
  /** The board's "merge on Done" switch. */
  autoMerge: boolean;
  /** How many commands the board declares in its bar. */
  declaredChecks: number;
  /** The board's workflow has the AI review column (`workflowHasStage`): without it server code is a person's. */
  aiReview?: boolean;
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
  /** `aiReviewCard`: do not refuse a card in AI review here, the caller applies that rule by the kind of delivery. */
  opts: { aiReviewCard?: boolean } = {},
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
  if (card.stage === STAGE_AI_REVIEW && !opts.aiReviewCard) return no("the card is in AI review, its opener closes it");
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
 * An EXTRA net over server code, never a way in: a file there that speaks to a
 * person, has an effect outside the machine, or is part of the machinery that
 * protects, pays, judges or deletes is a person's, even when the AI review would
 * have been enough. It can only send a file to a person, never admit one: the
 * verifier showed (09/11) that a vocabulary cannot say a file is harmless.
 *
 * Two nets. The first is a list of exact places (what a person's eyes must
 * always see, named one by one); the second reads a path as WORDS (`authGate.ts`
 * and `auth-gate.ts` are `auth`, `gate`) and stops it if any word starts with a
 * stem from the families below, so a file nobody listed but named in the same
 * vocabulary is caught too. Being wrong in this direction costs a person's
 * look; being wrong in the other costs a land nobody read.
 */
const NEVER_ALONE: ReadonlyArray<{ re: RegExp; why: string }> = [
  // Speaks to a person (the first black list).
  { re: /^server\/services\/(board-actions|ai-review-notice|card-origin-notice|worktree-abandon-notice|discord|dispatch-budget-message|profile-banner|calendar-feed|ical)/, why: "messages and feeds a person reads" },
  { re: /^server\/services\/delivery-sheet/, why: "the delivery sheet a person reads" },
  { re: /^server\/lib\/(stripe|licenza|nome-installazione|provenienza|dead-run-note|resume-notices)/, why: "licence, install name and notices" },
  { re: /^server\/lib\/(topics-agent-prompt|thread-skeleton|slash-command-menu|verdetto-turno-interrotto|turno-troncato|interrupted-turn-block)/, why: "prompts and thread text" },
  { re: /^server\/.*(push|discord|presence|notif|stripe|billing|licen[sz]|webhook|mailer|email|telegram|whatsapp|slack|banner|notice)/i, why: "a channel to a person" },
  // Names that no word reads (a boundary check on the path of every write guard).
  { re: /^server\/lib\/real-path\.ts$/, why: "the path boundary every write guard stands on" },
];

/** Word families: a path word that STARTS with a stem (`starts`) or IS one of `exact` makes the file a person's. */
const NEVER_ALONE_WORDS: ReadonlyArray<{ why: string; starts: readonly string[]; exact: readonly string[] }> = [
  {
    why: "security and authorization (who may call what, what leaves the machine)",
    starts: [
      "auth", "credential", "secret", "token", "permission", "grant", "principal", "pairing", "csrf", "cors", "cookie", "crypt", "keychain",
      "ssrf", "cert", "outbound", "unlock", "sandbox", "header", "login", "password", "passkey", "allow", "protect", "contain", "loopback",
      "private", "tunnel", "identity", "friendship", "account", "recipient", "trust", "privilege", "policy", "ipv", "redact", "hook",
    ],
    exact: ["tls", "origin", "acl", "scripts"],
  },
  {
    why: "a gate or a guard is a safety decision",
    starts: ["gate", "guard"],
    exact: [],
  },
  {
    why: "spend, quotas and what starts agents",
    starts: [
      "spend", "budget", "quota", "pric", "cost", "capacity", "governor", "dispatch", "delegat", "bill", "usage", "provider", "endpoint",
      "relay", "goal", "schedul", "night", "autonom", "approv", "model", "limit", "attempt", "remote", "machine",
    ],
    exact: ["cap", "node", "nodes"],
  },
  {
    why: "the land, its verdict and the bar: the judge of this very land",
    starts: [
      "land", "merge", "automerge", "deliver", "check", "residue", "checkpoint", "evidence", "verdict", "review", "workflow", "baseline", "board", "branch",
    ],
    exact: ["own", "tasks", "ci", "bar"],
  },
  {
    why: "deleting, stopping or rewriting data, worktrees and processes",
    starts: [
      "delet", "purg", "prun", "clean", "wipe", "reap", "kill", "abandon", "trash", "remov", "revoc", "retent", "restor", "archiv", "stop", "reload",
      "restart", "drop", "retire", "teardown", "sweep", "snapshot", "backup", "repair", "vacuum", "truncat", "reset", "evict", "expir", "orphan",
      "worktree", "process", "pid", "signal", "shutdown", "terminat", "destroy", "unlink", "migrat", "schema",
    ],
    exact: ["gc", "db"],
  },
];

/** A path as lower-case words: `authGate.ts`, `auth-gate.ts` and `auth_gate.ts` read alike. */
function wordsOf(path: string): string[] {
  return path.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Why a path is always a person's, or `null`. */
function whyAlwaysAPerson(path: string): string | null {
  const listed = NEVER_ALONE.find((e) => e.re.test(path));
  if (listed) return listed.why;
  const words = wordsOf(path);
  for (const family of NEVER_ALONE_WORDS) {
    if (words.some((w) => family.exact.includes(w) || family.starts.some((stem) => w.startsWith(stem)))) return family.why;
  }
  return null;
}

/**
 * WHAT MAY LAND WITH NO ONE LOOKING: text and tests, by PLACE.
 *
 *   - `docs/**` and `openspec/**`: nothing reads them as code;
 *   - a test file: `*.test.ts` beside its module, `tests/unit/**`,
 *     `tests/integration/**`, and `tests/e2e/**` specs.
 *
 * Out even when they sit under those folders, because they are not tests but
 * part of what judges or runs them: `tests/setup/**` (the preload every run
 * loads), every `*.json`, every snapshot, `scripts/**`, `.github/**`, and any
 * file that `bunfig.toml`, `scripts/`, `package.json` or `.github/` NAME
 * (`referencedByTheJudge`, asked of git at the commit).
 */
export function mayLandAloneByPlace(path: string): boolean {
  if (/(^|\/)node_modules\//.test(path)) return false;
  if (path.startsWith("tests/setup/") || path.startsWith("scripts/") || path.startsWith(".github/")) return false;
  if (/\.json$/i.test(path)) return false;
  if (/(^|\/)(__snapshots__|[^/]*-snapshots)\//.test(path) || /\.snap$/.test(path)) return false;
  if (path.startsWith("docs/") || path.startsWith("openspec/")) return true;
  if (path.startsWith("tests/")) {
    if (path.startsWith("tests/unit/") || path.startsWith("tests/integration/")) return true;
    return path.startsWith("tests/e2e/") && /\.spec\.[jt]sx?$/.test(path);
  }
  return /\.(test|spec)\.[jt]sx?$/.test(path);
}

/**
 * Server code that the board's AI review may approve: everything under `server/`
 * except the router (what a caller may do), the database (the shape of the live
 * data and the code that runs inside migrations), the browser (logins and site
 * data) and billing, which are a person's.
 */
function isServerCodeForAiReview(path: string): boolean {
  if (!path.startsWith("server/")) return false;
  if (/^server\/(routes|db)\//.test(path)) return false;
  if (/^server\/(browser-|usage\/)/.test(path)) return false;
  if (/\.json$/i.test(path)) return false;
  return true;
}

/** Who must look at a delivery: no one (`alone`), the board's AI review, or a person. */
export type DeliveryTier = "alone" | "ai-review" | "person";

export interface DeliveryReading {
  tier: DeliveryTier;
  /** The files that set the tier (the first of each kind is enough to say why). */
  files: string[];
}

/**
 * The tier of a delivery is the highest of its files: one file a person must
 * look at makes the whole delivery a person's. `judged` are the files that
 * the bar's own configuration names; they are never "alone", whatever their folder.
 */
export function classifyDelivery(files: readonly string[], judged: ReadonlySet<string> = new Set()): DeliveryReading {
  const person: string[] = [];
  const review: string[] = [];
  for (const f of files) {
    if (mayLandAloneByPlace(f) && !judged.has(f)) continue;
    if (isServerCodeForAiReview(f) && whyAlwaysAPerson(f) === null && !judged.has(f)) review.push(f);
    else person.push(f);
  }
  if (person.length > 0) return { tier: "person", files: person };
  if (review.length > 0) return { tier: "ai-review", files: review };
  return { tier: "alone", files: [] };
}

/** Does a diff reload the live server when it lands? Conservative: `shared/` counts. */
export function touchesServer(files: readonly string[] | null): boolean {
  // `null` = unknown, and the careful reading of unknown is "it does".
  if (files === null) return true;
  return files.some((f) => f.startsWith("server/") || f === "server.ts" || f.startsWith("shared/"));
}

/**
 * The model family of a model name: `claude-opus-4-7`, `opus[1m]` and `Opus` are
 * all `opus`; `gpt-5-codex` is `gpt`. "A different model" is a different family,
 * because a newer version of the same model reviews the way the old one writes.
 * `null` = no name, or one that starts with no letters: not a model we can tell.
 */
export function modelFamily(model: string | null | undefined): string | null {
  const m = (model ?? "").trim().toLowerCase().replace(/^[a-z0-9_.-]+\//, "").replace(/^claude-/, "");
  return /^[a-z]+/.exec(m)?.[0] ?? null;
}

/**
 * The line a reviewer writes as the FIRST line of a card comment to approve (or
 * refuse) one commit: `AI-REVIEW approved <40-hex sha>`. A sentence elsewhere in a
 * comment, or an abbreviated sha, is not a verdict.
 */
const AI_REVIEW_LINE = /^\s*AI-REVIEW\s+(approved|rejected)\s+([0-9a-f]{40})\b/i;

export interface AiReviewInput {
  /** The commit that would land. */
  commit: string;
  card: Pick<AutoLandCard, "stage" | "assignedTopicId" | "model">;
  board: Pick<AutoLandBoard, "aiReview">;
  thread: ReadonlyArray<AutoLandComment>;
  /** The model of an agent identity (`agent:<topicId>`), or `null` when it cannot be told. */
  modelOf: (author: string) => string | null;
}

/**
 * Has the board's AI review approved THIS commit? Server code lands alone only if
 * all of these hold, each one a way for the answer to be no:
 *   - the board has the AI review column (a board without it has no reviewer, and
 *     a person decides) and the card sits in it;
 *   - the last verdict line about this very sha is an approval (a later
 *     `rejected` for the same sha cancels it; a line about another sha says
 *     nothing about this one);
 *   - the reviewer is an agent identity, and its model family differs from every
 *     writer's (the assigned session and the authors of a delivery on the card)
 *     and from the one the card asked for. The session that wrote the card runs
 *     the model that wrote it, so it can never approve its own work. A model that
 *     cannot be told is not a different model.
 */
export function aiReviewVerdict(input: AiReviewInput): AutoLandVerdict {
  const no = (reason: string): AutoLandVerdict => ({ ok: false, reason });
  if (!input.board.aiReview) return no("the board has no AI review column, so a person decides");
  if (input.card.stage !== STAGE_AI_REVIEW) return no("the card is not in AI review");
  let last: { verb: "approved" | "rejected"; author: string } | null = null;
  for (const c of input.thread) {
    if (!isThreadSpeech(c)) continue;
    const m = AI_REVIEW_LINE.exec((c.content ?? "").split("\n")[0] ?? "");
    if (!m || !sameCommit(m[2], input.commit)) continue;
    last = { verb: m[1]!.toLowerCase() as "approved" | "rejected", author: c.author ?? "" };
  }
  if (!last) return no("the AI review has not approved this commit");
  if (last.verb === "rejected") return no("the AI review rejected this commit");
  if (commentAuthorLabel(last.author).kind !== "agent" || !last.author.startsWith("agent:")) {
    return no("the approval is not from an agent session");
  }
  const writers = new Set<string>();
  if (input.card.assignedTopicId) writers.add(`agent:${input.card.assignedTopicId}`);
  for (const c of input.thread) if (c.kind === "delivery" && c.author) writers.add(c.author);
  const reviewer = modelFamily(input.modelOf(last.author));
  if (!reviewer) return no("the reviewer's model cannot be told");
  const written = new Set<string>();
  for (const w of writers) {
    const f = modelFamily(input.modelOf(w));
    if (!f) return no("the model that wrote the card cannot be told");
    written.add(f);
  }
  const asked = modelFamily(input.card.model);
  if (asked) written.add(asked);
  if (written.size === 0) return no("the model that wrote the card cannot be told");
  if (written.has(reviewer)) return no(`the reviewer runs the same model (${reviewer}) as the one that wrote the card`);
  return { ok: true };
}

/** What the runner needs from the router; every name is the router's own door. */
interface AutoLanderDeps {
  read(taskId: string, projectId: string): { task: AutoLandCard & { id: string; projectId: string }; comments: ReadonlyArray<AutoLandComment> } | undefined;
  board(projectId: string): AutoLandBoard;
  /**
   * Queue the land (the router's `enqueueLand`), asking it NOT to realign the branch.
   * `recheck` is the verdict again, to be run INSIDE the repo's queue a moment
   * before the merge (the router hands it to `tryMerge` as `beforeMerge`). It is
   * told the commit about to be merged, and answers a reason to stop, or `null`:
   * it only says yes for the very commit this land was offered with, if the
   * verdict, the paths and the open turns still allow it.
   */
  land(projectId: string, taskId: string, recheck: (commit: string | null) => Promise<string | null>): unknown;
  note(taskId: string, text: string): void;
  /**
   * What the delivery changes on `commit`, the exact commit the land would merge
   * (net of main, nothing left out); `null` = unknown, and a land that does not
   * know what it changes does not happen.
   */
  files?: (taskId: string, commit: string) => Promise<string[] | null>;
  /**
   * Which of `files` (as of `commit`) are NAMED by what runs or judges the bar:
   * `bunfig.toml`, `scripts/`, `package.json`, `.github/`. A test file that the
   * bar's preload loads is the bar, not a test. `null` = unknown, and a land that
   * cannot tell does not happen.
   */
  referenced?: (taskId: string, commit: string, files: string[]) => Promise<string[] | null>;
  /** The model of an agent identity (`agent:<topicId>`), `null` = cannot be told. Without it no approval can be checked. */
  modelOf?: (author: string) => string | null;
  /**
   * Agent and chat turns open right now on this server (the restart gate's own
   * count). `insideLand`: asked from within the land itself, whose own slot in the
   * queue is not a turn to wait for.
   */
  liveTurns?: (opts?: { insideLand?: boolean }) => number | Promise<number>;
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

/** Everything the land rests on, read at one moment: the card, its board, and the paths OF THE COMMIT it names. */
type Decision =
  | { ok: true; files: string[]; commit: string; tier: "alone" | "ai-review" }
  | { ok: false; reason: string };

/**
 * Lands the card when the verdict allows it. A diff that reloads the live
 * server waits for ZERO open turns first: the land runs in the checkout the
 * server runs from, and the watcher reloads on the merge, which cuts every turn
 * in flight (task-automerge.ts, "the shared checkout is ALREADY on main").
 * The wait is a timer in this process: a reload loses it, which is why the
 * router also offers `sweep` and the host calls it after a boot.
 *
 * THE VERDICT IS NOT A PHOTOGRAPH. The wait lasts up to three hours and the
 * land queue minutes, and in that time the card can move to a newer commit
 * with other paths, be archived, or get a question. So the whole decision
 * (`decide`: card, bar, board, paths, AI review) is taken again at every beat,
 * and once more, with the open turns, right before the merge.
 */
export function createAutoLander(deps: AutoLanderDeps) {
  const waiting = new Set<string>();
  /** Cards between "the verdict said yes" and "the land is queued": a second ask in that gap is the same ask. */
  const askInFlight = new Set<string>();
  /**
   * The commit already handed to the land queue, per card. A land that comes
   * back `skipped` leaves the card in review with a green bar, so the verdict
   * would say yes again at every sweep: one land per ten minutes, forever, for
   * a refusal that cannot change until the branch does. A land STOPPED by its own
   * recheck forgets it: that stop is the verdict changing, which the next ask
   * reads for itself.
   */
  const attempted = new Map<string, string>();
  const log = deps.log ?? (() => undefined);
  const pollMs = deps.pollMs ?? 15_000;
  const maxWaitMs = deps.maxWaitMs ?? 3 * 60 * 60_000;

  /** The card as it is now and the verdict on it, in one snapshot (`got` and `board` are set when it could be read). */
  function readVerdict(projectId: string, taskId: string): {
    verdict: AutoLandVerdict;
    commit: string;
    got?: NonNullable<ReturnType<AutoLanderDeps["read"]>>;
    board?: AutoLandBoard;
  } {
    let got: ReturnType<AutoLanderDeps["read"]>;
    let board: AutoLandBoard;
    try { got = deps.read(taskId, projectId); board = deps.board(projectId); }
    // Unreadable settings must not land "because we did not know".
    catch { return { verdict: { ok: false, reason: "the card or its board could not be read" }, commit: "" }; }
    if (!got) return { verdict: { ok: false, reason: "the card is gone" }, commit: "" };
    // A card in AI review is not refused here: whether it may land depends on WHAT it delivers (`decide`).
    const verdict = autoLandVerdict(got.task, board, got.comments, { aiReviewCard: true });
    return { verdict, commit: got.task.deliveryCommit ?? "", got, board };
  }

  /**
   * The verdict plus the paths of the delivery, both about ONE commit: the one
   * the card names in the same snapshot as the bar. `expected` is the commit a
   * queued land was offered with; a card that has moved to another one is no
   * longer the land that was asked for, even if the new commit would pass.
   */
  async function decide(projectId: string, taskId: string, expected?: string): Promise<Decision> {
    const { verdict, commit, got, board } = readVerdict(projectId, taskId);
    if (!verdict.ok) return verdict;
    if (!got || !board) return { ok: false, reason: "the card or its board could not be read" };
    if (expected !== undefined && !sameCommit(expected, commit)) {
      return { ok: false, reason: `the card moved to another commit (${expected.slice(0, 8)} -> ${commit.slice(0, 8)}): it starts again from the new one` };
    }
    let files: string[] | null = null;
    try { files = deps.files ? await deps.files(taskId, commit) : null; } catch { files = null; }
    // A land that cannot say what it changes does not happen: the paths are the only reading of "a person must look".
    if (files === null) return { ok: false, reason: "the files of the delivery could not be read" };
    // Which of the test and document files the bar's own configuration names: those are the judge, not tests.
    const candidates = files.filter(mayLandAloneByPlace);
    let judged = new Set<string>();
    if (candidates.length > 0) {
      let named: string[] | null = null;
      try { named = deps.referenced ? await deps.referenced(taskId, commit, candidates) : null; } catch { named = null; }
      if (named === null) return { ok: false, reason: "what the bar's configuration names could not be read" };
      judged = new Set(named);
    }
    const reading = classifyDelivery(files, judged);
    if (reading.tier === "person") {
      return { ok: false, reason: `the delivery touches what a person must look at (${reading.files.slice(0, 3).join(", ")})` };
    }
    if (reading.tier === "alone") {
      if (got.task.stage === STAGE_AI_REVIEW) return { ok: false, reason: "the card is in AI review, its opener closes it" };
      return { ok: true, files, commit, tier: "alone" };
    }
    const review = aiReviewVerdict({
      commit, card: got.task, board, thread: got.comments,
      modelOf: (author) => { try { return deps.modelOf?.(author) ?? null; } catch { return null; } },
    });
    if (!review.ok) {
      return { ok: false, reason: `the delivery changes server code (${reading.files.slice(0, 3).join(", ")}) and ${review.reason}` };
    }
    return { ok: true, files, commit, tier: "ai-review" };
  }

  /**
   * The card's own turn must be over whatever the diff (landing cuts it); a server
   * diff also waits for ZERO open turns. `insideLand`: asked from within the land
   * itself, which must not wait for its own slot in the queue.
   */
  async function mustWait(taskId: string, files: readonly string[], how: { insideLand?: boolean } = {}): Promise<boolean> {
    if (deps.cardTurnLive?.(taskId) ?? false) return true;
    if (!touchesServer(files) || !deps.liveTurns) return false;
    try { return (await deps.liveTurns(how.insideLand ? { insideLand: true } : undefined)) > 0; } catch { return true; }
  }

  /** `commit` is the one the decision was taken on: the land is offered for it and for no other. */
  function landNow(projectId: string, taskId: string, commit: string, tier: "alone" | "ai-review"): void {
    attempted.set(taskId, commit);
    // Run INSIDE the repo's queue, a moment before the merge, with the commit about
    // to be merged. The note is written only if the decision still holds on THIS
    // commit: "landed alone" must not stand above a refusal. The decision includes
    // the open turns, read again: the wait that ended minutes ago is not a fact now.
    const recheck = async (toMerge: string | null): Promise<string | null> => {
      const stop = (why: string): string => { attempted.delete(taskId); return why; };
      if (!sameCommit(toMerge, commit)) {
        return stop(`the land to merge (${(toMerge ?? "none").slice(0, 8)}) is another commit than the one it was offered with (${commit.slice(0, 8)})`);
      }
      const d = await decide(projectId, taskId, commit);
      if (!d.ok) return stop(d.reason);
      if (await mustWait(taskId, d.files, { insideLand: true })) {
        return stop("an agent turn is open, and landing would cut it: the land waits for the next round");
      }
      try {
        deps.note(
          taskId,
          `Atterrata da sola: la barra della board è verde per intero sul commit consegnato (\`${commit.slice(0, 8)}\`), la card è invisibile ` +
            (tier === "ai-review"
              ? "e la revisione AI della board ha approvato proprio questo commit. "
              : "e non fa domande. ") +
            "Si chiude solo a merge confermato su main; se il ramo si è mosso o è rimasto indietro non lo tocco e resta in review.",
        );
      } catch (err) { log(`[auto-land] nota non scritta per ${taskId}: ${String(err)}`); }
      return null;
    };
    deps.land(projectId, taskId, recheck);
  }

  /** `quiet`: the periodic sweep asks about the same refused cards every round, and says nothing about them. */
  async function tryLand(projectId: string, taskId: string, how: { quiet?: boolean } = {}): Promise<AutoLandOutcome> {
    const refuse = (why: string): AutoLandOutcome => {
      if (!how.quiet) log(`[auto-land] ${taskId.slice(0, 8)} resta in review: ${why}`);
      return "refused";
    };
    const first = readVerdict(projectId, taskId);
    if (!first.verdict.ok) return refuse(first.verdict.reason);
    if (waiting.has(taskId) || askInFlight.has(taskId)) return "waiting";
    if (attempted.get(taskId) === first.commit) return refuse("this commit was already offered to the land");
    askInFlight.add(taskId);
    try {
      const d = await decide(projectId, taskId);
      if (!d.ok) return refuse(d.reason);
      if (!(await mustWait(taskId, d.files))) {
        landNow(projectId, taskId, d.commit, d.tier);
        return "queued";
      }
      waiting.add(taskId);
      const startedAt = Date.now();
      let beating = false;
      const timer = setInterval(() => {
        if (beating) return;
        beating = true;
        // Asked again at every beat, paths included: the card may have moved to a
        // newer commit, been closed or archived, or the agent may have asked something.
        void (async () => {
          try {
            const again = await decide(projectId, taskId);
            const expired = Date.now() - startedAt > maxWaitMs;
            if (!again.ok || expired) {
              clearInterval(timer); waiting.delete(taskId);
              log(`[auto-land] ${taskId.slice(0, 8)} non atterra piu': ${again.ok ? "attesa dei turni scaduta" : again.reason}`);
              return;
            }
            if (await mustWait(taskId, again.files)) return;
            clearInterval(timer); waiting.delete(taskId);
            landNow(projectId, taskId, again.commit, again.tier);
          } catch (err) {
            log(`[auto-land] ${taskId.slice(0, 8)} battito fallito, riprovo: ${String(err)}`);
          } finally {
            beating = false;
          }
        })();
      }, pollMs);
      (timer as { unref?: () => void }).unref?.();
      return "waiting";
    } finally {
      askInFlight.delete(taskId);
    }
  }

  /** Cards no longer in review start clean: a card sent back and delivered again at the same commit is asked again. */
  function forgetExcept(inReview: ReadonlySet<string>): void {
    for (const id of [...attempted.keys()]) if (!inReview.has(id)) attempted.delete(id);
  }

  return { tryLand, forgetExcept, isWaiting: (taskId: string) => waiting.has(taskId) };
}
