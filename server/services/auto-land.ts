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
 *   9. what only a person can judge stays a person's, named by place
 *      (`personPlace`): the interface, the public site, what reaches people,
 *      security and money, the dependency set, and the judge itself. Until
 *      14/11/2026 the net was the other way round (only text and tests landed
 *      alone, after 242 server files had slipped through a list of words); the
 *      owner's rule of 09/11 turned it: technical cards close themselves, with
 *      the whole bar green on the commit that lands.
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
 * WHAT MAY LAND WITH NO ONE LOOKING: everything technical, by PLACE.
 *
 * Until 14/11/2026 only text and tests landed alone, and every line of
 * `server/**` waited for a person: 104 cards closed by hand in two weeks, a
 * median of 4.8 hours each in review. The owner's rule (09/11) is the other way
 * round: technical cards close themselves; a person looks only at what only a
 * person can judge. So the list below names what stays a PERSON'S, and the rest
 * lands once the whole bar is green on the commit that lands:
 *
 *   - what a person SEES: `client/src/**` outside tests, the public site
 *     (`landing/**`), the README and the licence;
 *   - what REACHES a person or a third party: push, presence, notifications,
 *     mail, channels, voice, shares and guests;
 *   - SECURITY and MONEY: auth, tokens, secrets, the environment an agent runs
 *     in, the relay, licences, billing and prices, and the dependency set
 *     (`package.json`, lockfiles: installing a package is running its code);
 *   - THE JUDGE: what decides whether a card is green or may close alone (the
 *     CI and its scripts, the test preload, ratchet baselines and every JSON,
 *     snapshots, the checks gate, the labels, this module and its siblings).
 *     An agent that edits its own judge would sign its own release.
 *
 * Migrations land alone: the live database is copied every ten seconds
 * (Litestream), so a bad one is undone by a restore, not lost.
 */
const PERSON_PLACES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\/)node_modules\//, "dependencies"],
  [/^client\/src\//, "interface"],
  [/^(landing|site|public)\//, "public site"],
  [/^(README|LICENSE|PRIVACY|SECURITY|THIRD-PARTY-NOTICES)(\.|$)/i, "public text"],
  // A green main is released by itself (auto-bump → tauri-release): the shell, the relay and the nodes are a release.
  [/^(desktop-tauri|relay|deploy)\//, "release or infrastructure"],
  [/(^|\/)Cargo\.(toml|lock)$/, "release or infrastructure"],
  // Words read on EVERY segment of the path, not only the file name: `relay/src/worker.ts`, `claude-cloud/creds.ts`.
  [/(^|\/)[^/]*(push|presence|discord|notif|mail|channel|voice|whatsapp|telegram|share(?!d(\/|$))|guest)[^/]*(\/|$)/i, "reaches a person"],
  [/(^|\/)[^/]*(auth(?!or)|token|secret|crypt|creds?(\b|_|-|\.)|credential|permission|sandbox|relay|agent-env|child-env|licen[cs]|licenza|billing|stripe|pricing)[^/]*(\/|$)/i, "security or money"],
  [/(^|\/)(package\.json|bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bunfig\.toml)$/, "dependencies or runner"],
  [/^(scripts|\.github|tests\/setup)\//, "the judge"],
  // Under tests/ only the test files themselves are tests: helpers, fixtures and the e2e setup are what they stand on.
  [/^tests\//, "the judge"],
  [/\.json$/i, "the judge"],
  [/(^|\/)(__snapshots__|[^/]*-snapshots)\/|\.snap$/, "the judge"],
  // The whole road from a delivery to main: what measures it, what decides who closes it, what lands it.
  [/^server\/services\/(auto-land|red-bounce|checks-gate|checks-[a-z-]+|review-checks[^/]*|ci-[a-z-]+|integration-[a-z-]+|landing-[a-z-]+|node-delivery-meter|node-branch-plant|task-automerge[^/]*|task-merge|land-attribution-gate|deliveryReportChecks|board-actions)\.ts$/, "the judge"],
  [/^server\/routes\/(tasks|tasks-board|tasks-ci-phase)\.ts$/, "the judge"],
  [/^shared\/(task-labels|workflow|board)\.ts$/, "the judge"],
  [/^server\.ts$/, "the judge"],
];

const TEST_FILE = /\.(test|spec)\.[jt]sx?$/;

/** Why a file is a person's to look at, or `null` when it may land with no one looking. */
export function personPlace(path: string): string | null {
  // A test beside its module is a test even under client/src or server/push-*: it changes no behaviour.
  if (TEST_FILE.test(path) && !path.startsWith("tests/setup/") && !path.startsWith("scripts/") && !path.startsWith(".github/")) return null;
  for (const [re, why] of PERSON_PLACES) if (re.test(path)) return why;
  return null;
}

export function mayLandAloneByPlace(path: string): boolean {
  return personPlace(path) === null;
}

/** Who must look at a delivery: no one (`alone`) or a person. */
export type DeliveryTier = "alone" | "person";

export interface DeliveryReading {
  tier: DeliveryTier;
  /** The files that make it a person's (the first three are enough to say why). */
  files: string[];
}

/**
 * One file in a person's place makes the whole delivery a person's.
 * `judged` are the files that the bar's own configuration names; they are never
 * "alone", whatever their folder.
 */
export function classifyDelivery(files: readonly string[], judged: ReadonlySet<string> = new Set()): DeliveryReading {
  const person = files.filter((f) => !mayLandAloneByPlace(f) || judged.has(f));
  return person.length > 0 ? { tier: "person", files: person } : { tier: "alone", files: [] };
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
  /** Does a server diff of this card wait for ZERO open turns? Absent = yes. */
  waitsForTurns?: (taskId: string) => boolean;
  pollMs?: number;
  maxWaitMs?: number;
  log?: (line: string) => void;
}

type AutoLandOutcome = "queued" | "waiting" | "refused";

/** Everything the land rests on, read at one moment: the card, its board, and the paths OF THE COMMIT it names. */
type Decision = { ok: true; files: string[]; commit: string } | { ok: false; reason: string };

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
 * (`decide`: card, bar, board, paths) is taken again at every beat,
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
  function readVerdict(projectId: string, taskId: string): { verdict: AutoLandVerdict; commit: string } {
    let got: ReturnType<AutoLanderDeps["read"]>;
    let board: AutoLandBoard;
    try { got = deps.read(taskId, projectId); board = deps.board(projectId); }
    // Unreadable settings must not land "because we did not know".
    catch { return { verdict: { ok: false, reason: "the card or its board could not be read" }, commit: "" }; }
    if (!got) return { verdict: { ok: false, reason: "the card is gone" }, commit: "" };
    const verdict = autoLandVerdict(got.task, board, got.comments);
    return { verdict, commit: got.task.deliveryCommit ?? "" };
  }

  /**
   * The verdict plus the paths of the delivery, both about ONE commit: the one
   * the card names in the same snapshot as the bar. `expected` is the commit a
   * queued land was offered with; a card that has moved to another one is no
   * longer the land that was asked for, even if the new commit would pass.
   */
  async function decide(projectId: string, taskId: string, expected?: string): Promise<Decision> {
    const { verdict, commit } = readVerdict(projectId, taskId);
    if (!verdict.ok) return verdict;
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
    return { ok: true, files, commit };
  }

  /**
   * The card's own turn must be over whatever the diff (landing cuts it); a server
   * diff also waits for ZERO open turns. `insideLand`: asked from within the land
   * itself, which must not wait for its own slot in the queue.
   */
  async function mustWait(taskId: string, files: readonly string[], how: { insideLand?: boolean } = {}): Promise<boolean> {
    if (deps.cardTurnLive?.(taskId) ?? false) return true;
    if (!touchesServer(files) || !deps.liveTurns) return false;
    if (deps.waitsForTurns && !deps.waitsForTurns(taskId)) return false;
    try { return (await deps.liveTurns(how.insideLand ? { insideLand: true } : undefined)) > 0; } catch { return true; }
  }

  /** `commit` is the one the decision was taken on: the land is offered for it and for no other. */
  function landNow(projectId: string, taskId: string, commit: string): void {
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
            "e non fa domande. Si chiude solo a merge confermato su main; se il ramo si è mosso o è rimasto indietro non lo tocco e resta in review.",
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
        landNow(projectId, taskId, d.commit);
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
            landNow(projectId, taskId, again.commit);
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
