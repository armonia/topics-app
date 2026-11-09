/**
 * The verdict of the automatic land, case by case (`auto-land.ts`).
 * The route-level cases live in `routes/tasks.autoland.test.ts`; here the
 * refusals that need no router: labels, bar coverage, commits, questions.
 *
 * @covers LAND-05
 */
import { describe, expect, test } from "bun:test";
import {
  aiReviewVerdict, autoLandVerdict, classifyDelivery, createAutoLander, mayLandAloneByPlace, modelFamily, sameCommit, touchesServer,
  type AutoLandBoard, type AutoLandCard, type AutoLandComment,
} from "./auto-land";

const BOARD: AutoLandBoard = { autoMerge: true, declaredChecks: 2 };
const green = [{ ok: true }, { ok: true }];

function card(over: Partial<AutoLandCard & { id: string; projectId: string }> = {}): AutoLandCard & { id: string; projectId: string } {
  return {
    status: "review", labels: [{ label: "invisibile" }, { label: "chore" }],
    checksState: "pass", checksCommit: "abc1234def", checks: green,
    deliveryBranch: "topics/x", deliveryCommit: "abc1234def5678",
    id: "t1", projectId: "p1",
    ...over,
  };
}
const verdict = (c: AutoLandCard, b: AutoLandBoard = BOARD, thread: Parameters<typeof autoLandVerdict>[2] = []) => autoLandVerdict(c, b, thread);

describe("autoLandVerdict", () => {
  test("invisible, whole bar green on the delivered commit, no question: ok", () => {
    expect(verdict(card())).toEqual({ ok: true });
  });

  test.each([
    ["visibile", { labels: [{ label: "visibile" }] }],
    ["decisione", { labels: [{ label: "decisione" }] }],
    ["no label at all", { labels: [] }],
  ])("%s is a person's card", (_n, over) => {
    expect(verdict(card(over)).ok).toBe(false);
  });

  test.each([
    ["red", { checksState: "fail" as const }],
    ["not measured", { checksState: null }],
    ["unknown", { checksState: "unknown" as const }],
    ["still running", { checksState: "running" as const }],
  ])("a bar that is %s lands nothing", (_n, over) => {
    expect(verdict(card(over)).ok).toBe(false);
  });

  test("a bar with fewer rows than the board declares is not the whole bar", () => {
    expect(verdict(card({ checks: [{ ok: true }] })).ok).toBe(false);
  });

  test("a board with no bar has nothing that could be green", () => {
    expect(verdict(card({ checks: [] }), { autoMerge: true, declaredChecks: 0 }).ok).toBe(false);
  });

  test("the bar measured another commit than the delivered one", () => {
    expect(verdict(card({ checksCommit: "1111111aaa" })).ok).toBe(false);
    expect(verdict(card({ checksCommit: null })).ok).toBe(false);
  });

  test("a plan with no commit of its own does not close itself", () => {
    expect(verdict(card({ deliveryCommit: null })).ok).toBe(false);
    expect(verdict(card({ deliveryBranch: null })).ok).toBe(false);
  });

  test("the board's automatic merge off", () => {
    expect(verdict(card(), { autoMerge: false, declaredChecks: 2 }).ok).toBe(false);
  });

  test("a human_ask, or the agent's last word being a question", () => {
    expect(verdict(card({ humanAsk: "guarda il testo" })).ok).toBe(false);
    const question = { author: "claude", kind: "comment", content: "```question\nLo tengo?\n- Si\n- No\n```" };
    expect(verdict(card(), BOARD, [question]).ok).toBe(false);
  });

  test("the land button offered as an option is a delivery, not a question", () => {
    const delivery = { author: "claude", kind: "comment", content: "```question\nFatto.\n- Landa su main\n```" };
    expect(verdict(card(), BOARD, [delivery]).ok).toBe(true);
  });

  test("a card in AI review is closed by its opener, unless the caller applies that rule by the kind of delivery", () => {
    expect(verdict(card({ stage: "ai_review" })).ok).toBe(false);
    expect(autoLandVerdict(card({ stage: "ai_review" }), BOARD, [], { aiReviewCard: true })).toEqual({ ok: true });
  });

  test("open steps keep the parent in review", () => {
    expect(verdict(card({ subtaskCount: 3, subtaskDoneCount: 2 })).ok).toBe(false);
  });

  test("a run that ended on an error is a partial delivery, not a clean one", () => {
    expect(verdict(card({ dispatchError: "quota esaurita a meta' commit" })).ok).toBe(false);
  });

  test("a person's word after the card entered review keeps it for that person", () => {
    const reviewAt = "2026-11-09T10:00:00.000Z";
    const before = { author: "user", kind: "comment", content: "ok, vai", createdAt: "2026-11-09T09:00:00.000Z" };
    const after = { author: "user", kind: "comment", content: "non landare", createdAt: "2026-11-09T10:05:00.000Z" };
    const note = { author: "user", kind: "comment", content: "appunto mio", createdAt: "2026-11-09T10:06:00.000Z", quiet: true };
    expect(verdict(card({ reviewAt }), BOARD, [before]).ok).toBe(true);
    expect(verdict(card({ reviewAt }), BOARD, [before, after]).ok).toBe(false);
    expect(verdict(card({ reviewAt }), BOARD, [before, note]).ok).toBe(true);
    // No review stamp: only a person speaking last counts.
    expect(verdict(card(), BOARD, [{ author: "claude", content: "fatto" }, { author: "user", content: "aspetta" }]).ok).toBe(false);
    expect(verdict(card(), BOARD, [{ author: "user", content: "vai" }, { author: "claude", content: "fatto" }]).ok).toBe(true);
  });

  test("a card already out of review", () => {
    expect(verdict(card({ status: "done" })).ok).toBe(false);
  });
});

describe("sameCommit / touchesServer", () => {
  test("abbreviated and full shas of the same commit match; short or empty never do", () => {
    expect(sameCommit("abc1234", "abc1234def5678")).toBe(true);
    expect(sameCommit("abc12", "abc12")).toBe(false);
    expect(sameCommit(null, "abc1234")).toBe(false);
  });

  test("server files, server.ts and shared reload the live server; unknown counts as yes", () => {
    expect(touchesServer(["server/x.ts"])).toBe(true);
    expect(touchesServer(["server.ts"])).toBe(true);
    expect(touchesServer(["shared/board.ts"])).toBe(true);
    expect(touchesServer(["scripts/check-x.ts", "docs/a.md"])).toBe(false);
    expect(touchesServer(null)).toBe(true);
  });
});

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const approval = (author: string, sha = SHA, verb = "approved"): AutoLandComment => ({
  author, kind: "comment", content: `AI-REVIEW ${verb} ${sha}\nLetto il diff: nessun effetto fuori dai test.`, createdAt: "2026-11-09T11:00:00.000Z",
});

describe("mayLandAloneByPlace / classifyDelivery: only text and tests land with no one looking", () => {
  test.each([
    "docs/board-protocol.md", "openspec/changes/x/proposal.md",
    "server/lib/git-numstat.test.ts", "server/push-triggers.test.ts", "client/src/state/board.test.tsx",
    "tests/unit/x.test.ts", "tests/integration/migration-071.test.ts", "tests/e2e/board.spec.ts", "tests/e2e/deep/a.spec.ts",
  ])("%s is text or a test: it lands alone", (f) => {
    expect(mayLandAloneByPlace(f)).toBe(true);
    expect(classifyDelivery([f])).toEqual({ tier: "alone", files: [] });
  });

  test.each([
    // The preload every run loads, data files, snapshots, helpers and e2e support are not tests.
    "tests/setup/bun-test-preload.ts", "tests/setup/anything.test.ts", "tests/unit/data.json", "docs/schema.json", "openspec/changes/x/.openspec.json",
    "tests/e2e/global-setup.ts", "tests/e2e/board.spec.ts-snapshots/a.png", "tests/unit/__snapshots__/x.snap", "tests/unit/x.snap",
    "tests/helpers/time-slack.ts", "tests/fixtures/repo.ts",
    // The CI guards and their own tests are the judge.
    "scripts/check-security.ts", "scripts/check-eol.test.ts", ".github/workflows/ci.yml",
    "package.json", "bunfig.toml", "LICENSE", "README.md", "landing/index.html", "client/src/App.tsx", "shared/board.ts", "server.ts", "newdir/anything.ts",
  ])("%s is not text or a test: a person looks", (f) => {
    expect(mayLandAloneByPlace(f)).toBe(false);
    expect(classifyDelivery([f]).tier).not.toBe("alone");
  });

  test("a test file or a document that the bar's configuration NAMES is the judge, not a test", () => {
    const loaded = "tests/unit/helpers/preload-extra.test.ts";
    expect(classifyDelivery([loaded]).tier).toBe("alone");
    expect(classifyDelivery([loaded], new Set([loaded]))).toEqual({ tier: "person", files: [loaded] });
    expect(classifyDelivery(["docs/board-protocol.md", "docs/a.md"], new Set(["docs/board-protocol.md"])).files).toEqual(["docs/board-protocol.md"]);
  });

  // The verifier's files (09/11, repro `e2e-files.ts`): the vocabulary net let 242 server files through, and each of these
  // changes what protects, pays, deletes or judges. None of them may land alone any more.
  test.each([
    "server/lib/low-priority.ts", "server/lib/agent-env.ts", "server/lib/child-env.ts", "server/services/known-project-dirs.ts",
    "server/lib/project-visibility.ts", "server/lib/session-free-mode.ts", "server/lib/quiescence.ts", "server/services/project-store.ts",
    "server/lib/transcript-keeper.ts", "server/lib/intent-classifier.ts", "server/services/preview-manager.ts",
    "server/lib/bounded-spawn.ts", "server/lib/serial-queue.ts", "server/lib/git-numstat.ts", "server/utils/path-env.ts",
  ])("%s is server code: never alone, at best the AI review's", (f) => {
    expect(classifyDelivery([f]).tier).not.toBe("alone");
  });

  test("server code the vocabulary net does not name goes to the AI review; the net only sends files to a person", () => {
    expect(classifyDelivery(["server/lib/git-numstat.ts"])).toEqual({ tier: "ai-review", files: ["server/lib/git-numstat.ts"] });
    expect(classifyDelivery(["server/lib/agent-env.ts", "docs/a.md"]).tier).toBe("ai-review");
    for (const f of ["server/lib/auth-gate.ts", "server/services/task-dispatcher.ts", "server/services/auto-land.ts", "server/lib/real-path.ts",
      "server/services/worktree-gc.ts", "server/push-triggers.ts", "server/services/board-actions.ts", "server/lib/stripe.ts"]) {
      expect(classifyDelivery([f])).toEqual({ tier: "person", files: [f] });
    }
  });

  test("camelCase and kebab-case read the same: a file name is not a way around the net", () => {
    expect(classifyDelivery(["server/lib/authGate.ts", "server/lib/servedFileHeaders.ts"]).tier).toBe("person");
  });

  test.each([
    // The router, the database, the browser and billing are a person's, whatever the file is called.
    "server/routes/notes.ts", "server/routes/tasks.ts", "server/db/schema.ts", "server/db/migrations/20261109-x.sql",
    "server/browser-site-data.ts", "server/browser-login-state.ts", "server/usage/pricing.ts", "server/package.json",
    // Outside server/: product text, the shared contract, the shell, the entry point.
    "shared/tool-detail.ts", "desktop-tauri/src-tauri/tauri.conf.json", "client/public/icon.png", "bun.lock",
  ])("%s is a person's, not even the AI review's", (f) => {
    expect(classifyDelivery([f]).tier).toBe("person");
  });

  test("the tier is the highest of the files, and the files that set it are named", () => {
    expect(classifyDelivery(["docs/a.md", "tests/unit/a.test.ts"]).tier).toBe("alone");
    expect(classifyDelivery(["docs/a.md", "server/lib/git-numstat.ts"])).toEqual({ tier: "ai-review", files: ["server/lib/git-numstat.ts"] });
    expect(classifyDelivery(["server/lib/git-numstat.ts", "LICENSE", "docs/a.md"])).toEqual({ tier: "person", files: ["LICENSE"] });
  });

  test("an empty diff has nothing a person must read", () => {
    expect(classifyDelivery([]).tier).toBe("alone");
  });
});

describe("modelFamily: a different model is a different family, not a different version", () => {
  test.each([
    ["claude-opus-4-7", "opus"], ["Opus", "opus"], ["opus[1m]", "opus"], ["claude-sonnet-5-5", "sonnet"], ["anthropic/claude-haiku-4-5", "haiku"],
    ["gpt-5-codex", "gpt"], ["gemini-2.5-pro", "gemini"],
  ])("%s is %s", (m, f) => expect(modelFamily(m)).toBe(f));
  test.each([[null], [""], ["  "], ["4-7"], [undefined]])("%p cannot be told", (m) => expect(modelFamily(m)).toBeNull());
});

describe("aiReviewVerdict: server code lands alone only on the board's AI review of THIS commit", () => {
  const models: Record<string, string | null> = { "agent:w1": "claude-sonnet-5-5", "agent:r1": "claude-opus-4-7", "agent:r2": "claude-sonnet-4-6", "agent:r3": null };
  const input = (over: { stage?: string; aiReview?: boolean; thread?: AutoLandComment[]; assignedTopicId?: string | null; model?: string | null } = {}) => ({
    commit: SHA,
    card: { stage: over.stage ?? "ai_review", assignedTopicId: "assignedTopicId" in over ? over.assignedTopicId : "w1", model: "model" in over ? over.model : "sonnet" },
    board: { aiReview: over.aiReview ?? true },
    thread: over.thread ?? [approval("agent:r1")],
    modelOf: (a: string) => models[a] ?? null,
  });

  test("an approval of this sha by another session on another model: yes", () => {
    expect(aiReviewVerdict(input())).toEqual({ ok: true });
  });

  test("a board with no AI review column has no reviewer: a person decides", () => {
    expect(aiReviewVerdict(input({ aiReview: false }))).toMatchObject({ ok: false });
  });

  test("a card that is not in the AI review column was not reviewed there", () => {
    expect(aiReviewVerdict(input({ stage: "human_review" }))).toMatchObject({ ok: false });
  });

  test("no verdict line, a verdict about another sha, an abbreviated sha: not approved", () => {
    expect(aiReviewVerdict(input({ thread: [] })).ok).toBe(false);
    expect(aiReviewVerdict(input({ thread: [approval("agent:r1", "b".repeat(40))] })).ok).toBe(false);
    expect(aiReviewVerdict(input({ thread: [{ author: "agent:r1", content: `AI-REVIEW approved ${SHA.slice(0, 12)}` }] })).ok).toBe(false);
  });

  test("the line must open the comment: a sentence quoting it is not a verdict", () => {
    expect(aiReviewVerdict(input({ thread: [{ author: "agent:r1", content: `Ho letto tutto.\nAI-REVIEW approved ${SHA}` }] })).ok).toBe(false);
  });

  test("the LAST verdict about this sha wins; one about another sha changes nothing", () => {
    const other = "c".repeat(40);
    expect(aiReviewVerdict(input({ thread: [approval("agent:r1"), approval("agent:r1", SHA, "rejected")] })).ok).toBe(false);
    expect(aiReviewVerdict(input({ thread: [approval("agent:r1", SHA, "rejected"), approval("agent:r1")] })).ok).toBe(true);
    expect(aiReviewVerdict(input({ thread: [approval("agent:r1"), approval("agent:r1", other, "rejected")] })).ok).toBe(true);
    // A rejection counts whoever writes it: the careful direction.
    expect(aiReviewVerdict(input({ thread: [approval("agent:r1"), approval("user", SHA, "rejected")] })).ok).toBe(false);
  });

  test("an approval from a person, the system or a guest is not the AI review", () => {
    for (const author of ["user", "system", "dispatcher", "verifier", "guest:dev1", "Claude Code"]) {
      expect(aiReviewVerdict(input({ thread: [approval(author)] })).ok).toBe(false);
    }
  });

  test("the model that wrote the card cannot approve it: not its own session, not one that delivered on it earlier", () => {
    models["agent:w1"] = "claude-sonnet-5-5";
    expect(aiReviewVerdict(input({ thread: [approval("agent:w1")] })).ok).toBe(false);
    // Nor can one that delivered on it earlier, though it is no longer the assigned session.
    const previousRound: AutoLandComment = { author: "agent:r1", kind: "delivery", content: "Consegna del primo giro." };
    expect(aiReviewVerdict(input({ thread: [previousRound, approval("agent:r1")] })).ok).toBe(false);
  });

  test("the same model family, an unknown reviewer model, an unknown writer model: no", () => {
    expect(aiReviewVerdict(input({ thread: [approval("agent:r2")] })).ok).toBe(false); // sonnet reviews sonnet
    expect(aiReviewVerdict(input({ thread: [approval("agent:r3")] })).ok).toBe(false); // reviewer model unknown
    expect(aiReviewVerdict(input({ assignedTopicId: "gone", model: null })).ok).toBe(false); // writer model unknown, none asked
    expect(aiReviewVerdict(input({ model: "claude-opus-4-1" })).ok).toBe(false); // the card ASKED for opus and opus reviews it
  });

  test("with the writer's topic gone but the model the card asked for known, a different family still reviews it", () => {
    expect(aiReviewVerdict(input({ assignedTopicId: null, model: "haiku" }))).toEqual({ ok: true });
  });
});

describe("createAutoLander", () => {
  const base = (over: { files?: string[] | null; board?: AutoLandBoard; card?: ReturnType<typeof card>; thread?: AutoLandComment[] } = {}) => {
    const state = {
      card: over.card ?? card(), board: over.board ?? BOARD, thread: over.thread ?? ([] as AutoLandComment[]),
      lands: 0, notes: [] as string[], files: ("files" in over ? over.files : ["docs/note.md"]) as string[] | null,
      cardLive: false, turns: 0, fileReads: 0, turnAsks: [] as Array<{ insideLand?: boolean } | undefined>,
      /** What the bar's configuration names, per ask. */
      named: [] as string[] | null, namedAsks: 0,
      models: { "agent:w1": "claude-sonnet-5-5", "agent:r1": "claude-opus-4-7" } as Record<string, string | null>,
      /** The commit each path read was asked about. */
      fileCommits: [] as string[],
      precheck: null as null | ((commit: string | null) => Promise<string | null>),
    };
    const lander = createAutoLander({
      read: () => ({ task: state.card, comments: state.thread }),
      board: () => state.board,
      land: (_p, _t, precheck) => { state.lands += 1; state.precheck = precheck; },
      note: (_t, text) => { state.notes.push(text); },
      files: async (_taskId, commit) => { state.fileReads += 1; state.fileCommits.push(commit); return state.files; },
      referenced: async () => { state.namedAsks += 1; return state.named; },
      modelOf: (a) => state.models[a] ?? null,
      liveTurns: async (how) => { state.turnAsks.push(how); return state.turns; },
      cardTurnLive: () => state.cardLive,
      pollMs: 5,
    });
    return { state, lander };
  };
  /** A card ready for the AI review gate: in the column, written by w1, reviewed by r1 on SHA. */
  const reviewed = (over: Partial<Parameters<typeof card>[0]> = {}) =>
    card({ stage: "ai_review", deliveryCommit: SHA, checksCommit: SHA, assignedTopicId: "w1", model: "sonnet", ...over });
  const serverFiles = ["server/lib/git-numstat.ts"];
  const aiBoard: AutoLandBoard = { ...BOARD, aiReview: true };

  test("a delivery touching a path a person must look at is refused", async () => {
    const { state, lander } = base({ files: ["server/push-triggers.ts"] });
    expect(await lander.tryLand("p1", "t1")).toBe("refused");
    expect(state.lands).toBe(0);
  });

  test("files that cannot be read refuse the land", async () => {
    const { state, lander } = base({ files: null });
    expect(await lander.tryLand("p1", "t1")).toBe("refused");
    expect(state.lands).toBe(0);
  });

  test("text and tests land alone", async () => {
    const { state, lander } = base({ files: ["docs/board-protocol.md", "server/lib/git-numstat.test.ts"] });
    expect(await lander.tryLand("p1", "t1")).toBe("queued");
    expect(state.lands).toBe(1);
  });

  test("a test file the bar's configuration names is the judge: refused; when that cannot be read, refused", async () => {
    const { state, lander } = base({ files: ["tests/unit/helpers/loaded.test.ts"] });
    state.named = ["tests/unit/helpers/loaded.test.ts"];
    expect(await lander.tryLand("p1", "t1")).toBe("refused");
    state.named = null;
    expect(await lander.tryLand("p1", "t1")).toBe("refused");
    expect(state.lands).toBe(0);
    expect(state.namedAsks).toBe(2);
  });

  test("git is not asked what the configuration names when no file could be a test or a document", async () => {
    const { state, lander } = base({ files: ["LICENSE"] });
    await lander.tryLand("p1", "t1");
    expect(state.namedAsks).toBe(0);
  });

  test("server code with no AI review column on the board: a person's, however green the bar", async () => {
    const { state, lander } = base({ files: serverFiles, card: reviewed(), thread: [approval("agent:r1")], board: BOARD });
    expect(await lander.tryLand("p1", "t1")).toBe("refused");
    expect(state.lands).toBe(0);
  });

  test("server code not yet reviewed waits for the AI review and lands no sooner than its approval of this commit", async () => {
    const { state, lander } = base({ files: serverFiles, card: reviewed(), board: aiBoard });
    expect(await lander.tryLand("p1", "t1")).toBe("refused");
    state.thread = [approval("agent:r1", "d".repeat(40))];
    expect(await lander.tryLand("p1", "t1")).toBe("refused");
    state.thread = [approval("agent:r1")];
    expect(await lander.tryLand("p1", "t1")).toBe("queued");
    expect(state.lands).toBe(1);
  });

  test("the approval of a session that wrote the card, or of the same model, does not land it", async () => {
    const { state, lander } = base({ files: serverFiles, card: reviewed(), board: aiBoard, thread: [approval("agent:w1")] });
    expect(await lander.tryLand("p1", "t1")).toBe("refused");
    state.models["agent:r1"] = "claude-sonnet-4-6";
    state.thread = [approval("agent:r1")];
    expect(await lander.tryLand("p1", "t1")).toBe("refused");
    expect(state.lands).toBe(0);
  });

  test("an approved server delivery says so in the note it writes when it really goes to merge", async () => {
    const { state, lander } = base({ files: serverFiles, card: reviewed(), board: aiBoard, thread: [approval("agent:r1")] });
    expect(await lander.tryLand("p1", "t1")).toBe("queued");
    expect(await state.precheck!(SHA)).toBeNull();
    expect(state.notes.join(" ")).toContain("revisione AI");
  });

  test("an approval that is withdrawn before the merge stops the land: the recheck reads the thread again", async () => {
    const { state, lander } = base({ files: serverFiles, card: reviewed(), board: aiBoard, thread: [approval("agent:r1")] });
    await lander.tryLand("p1", "t1");
    state.thread = [approval("agent:r1"), approval("agent:r1", SHA, "rejected")];
    expect(await state.precheck!(SHA)).toContain("rejected");
    expect(state.notes).toEqual([]);
  });

  test("text that is not server code in a card sitting in AI review is still closed by its opener", async () => {
    const { state, lander } = base({ files: ["docs/note.md"], card: reviewed(), board: aiBoard });
    expect(await lander.tryLand("p1", "t1")).toBe("refused");
    expect(state.lands).toBe(0);
  });

  test("a commit already offered to the land is not offered again, a new commit is", async () => {
    const { state, lander } = base();
    expect(await lander.tryLand("p1", "t1")).toBe("queued");
    expect(await lander.tryLand("p1", "t1", { quiet: true })).toBe("refused");
    expect(await lander.tryLand("p1", "t1", { quiet: true })).toBe("refused");
    expect(state.lands).toBe(1);
    state.card = card({ deliveryCommit: "fffffff0000", checksCommit: "fffffff" });
    expect(await lander.tryLand("p1", "t1")).toBe("queued");
    expect(state.lands).toBe(2);
  });

  test("a card that left review is asked again at the same commit", async () => {
    const { state, lander } = base();
    await lander.tryLand("p1", "t1");
    lander.forgetExcept(new Set());
    await lander.tryLand("p1", "t1");
    expect(state.lands).toBe(2);
  });

  test("two asks in the same instant queue one land", async () => {
    const { state, lander } = base();
    await Promise.all([lander.tryLand("p1", "t1"), lander.tryLand("p1", "t1")]);
    expect(state.lands).toBe(1);
  });

  test("the card's own agent still in its turn: the land waits for the turn to end, whatever the diff", async () => {
    const { state, lander } = base();
    state.cardLive = true;
    expect(await lander.tryLand("p1", "t1")).toBe("waiting");
    await Bun.sleep(30);
    expect(state.lands).toBe(0);
    state.cardLive = false;
    await Bun.sleep(30);
    expect(state.lands).toBe(1);
  });

  test("while waiting, a question the agent writes right after cancels the land", async () => {
    const { state, lander } = base();
    state.cardLive = true;
    await lander.tryLand("p1", "t1");
    state.card = card({ humanAsk: "guarda il testo" });
    state.cardLive = false;
    await Bun.sleep(30);
    expect(state.lands).toBe(0);
  });

  test("the paths are read again at every beat: a newer commit with other files stops the waiting land", async () => {
    const { state, lander } = base();
    state.cardLive = true;
    expect(await lander.tryLand("p1", "t1")).toBe("waiting");
    // While it waits the card moves to a new delivery with a green bar, and the new commit touches what a person must read.
    state.files = ["server/routes/auth.ts", "PRIVACY.md"];
    state.card = card({ deliveryCommit: "bbbbbbb2xxxx", checksCommit: "bbbbbbb2" });
    state.cardLive = false;
    await Bun.sleep(40);
    expect(state.lands).toBe(0);
    expect(state.fileReads).toBeGreaterThan(1);
  });

  test("a server diff waits on an async turn count too", async () => {
    const { state, lander } = base({ files: serverFiles, card: reviewed(), board: aiBoard, thread: [approval("agent:r1")] });
    state.turns = 1;
    expect(await lander.tryLand("p1", "t1")).toBe("waiting");
    await Bun.sleep(30);
    expect(state.lands).toBe(0);
    state.turns = 0;
    await Bun.sleep(30);
    expect(state.lands).toBe(1);
  });

  test("the land carries a recheck for the moment before the merge: card, files, everything again", async () => {
    const { state, lander } = base();
    expect(await lander.tryLand("p1", "t1")).toBe("queued");
    const offered = "abc1234def5678";
    const recheck = state.precheck!;
    expect(await recheck(offered)).toBeNull();
    // Between the ask and the merge (a queue behind other lands) the world moved.
    state.files = ["LICENSE"];
    expect(await recheck(offered)).toContain("LICENSE");
    state.files = ["docs/note.md"];
    state.card = card({ archived: true });
    expect(await recheck(offered)).not.toBeNull();
    state.card = card({ humanAsk: "guarda" });
    expect(await recheck(offered)).not.toBeNull();
    state.files = null;
    state.card = card();
    expect(await recheck(offered)).not.toBeNull();
  });

  test("the recheck reads the open turns again, as the land's own: a turn that opened in the queue stops a server diff", async () => {
    const { state, lander } = base({ files: serverFiles, card: reviewed(), board: aiBoard, thread: [approval("agent:r1")] });
    expect(await lander.tryLand("p1", "t1")).toBe("queued");
    state.turnAsks.length = 0;
    // The card's agent woke up and three turns are open when the queue hands over.
    state.cardLive = true; state.turns = 3;
    const stop = await state.precheck!(SHA);
    expect(stop).toContain("turn");
    expect(state.turnAsks).toEqual([]); // the card's own turn is enough: no need to count the others
    state.cardLive = false;
    expect(await state.precheck!(SHA)).toContain("turn");
    // It asked the count as a land asking about itself: its own slot in the queue is not a turn to wait for.
    expect(state.turnAsks).toEqual([{ insideLand: true }]);
    state.turns = 0;
    expect(await state.precheck!(SHA)).toBeNull();
  });

  test("a land stopped on a turn is asked again by the next sweep, not refused as 'already offered'", async () => {
    const { state, lander } = base({ files: serverFiles, card: reviewed(), board: aiBoard, thread: [approval("agent:r1")] });
    expect(await lander.tryLand("p1", "t1")).toBe("queued");
    state.turns = 2;
    expect(await state.precheck!(SHA)).toContain("turn");
    state.turns = 0;
    expect(await lander.tryLand("p1", "t1", { quiet: true })).toBe("queued");
    expect(state.lands).toBe(2);
  });

  test("the paths are read on the exact commit the verdict is about, never on a branch that moves", async () => {
    const { state, lander } = base();
    expect(await lander.tryLand("p1", "t1")).toBe("queued");
    expect(state.fileCommits).toEqual(["abc1234def5678"]);
    await state.precheck!("abc1234def5678");
    expect(state.fileCommits).toEqual(["abc1234def5678", "abc1234def5678"]);
  });

  test("the recheck refuses a commit other than the one the land was offered with, even if the new one is also green", async () => {
    const { state, lander } = base();
    expect(await lander.tryLand("p1", "t1")).toBe("queued");
    const recheck = state.precheck!;
    // The card is delivered again at a harmless commit with a green bar: the verdict on IT would be yes, but it is not what was offered.
    state.card = card({ deliveryCommit: "bbbbbbb2xxxx", checksCommit: "bbbbbbb2" });
    const stop = await recheck("abc1234def5678");
    expect(stop).toContain("another commit");
    // The land the queue is about to merge (read by the router) is the new one while the offer was the old one: same refusal.
    expect(await recheck("bbbbbbb2xxxx")).toContain("another commit");
    // Nothing read the new commit's paths for a land that was never asked about it.
    expect(state.fileCommits).toEqual(["abc1234def5678"]);
  });

  test("a waiting land that sees a newer commit asks about THAT commit: its paths are read on it", async () => {
    const { state, lander } = base();
    state.cardLive = true;
    expect(await lander.tryLand("p1", "t1")).toBe("waiting");
    state.card = card({ deliveryCommit: "bbbbbbb2xxxx", checksCommit: "bbbbbbb2" });
    state.cardLive = false;
    await Bun.sleep(40);
    expect(state.lands).toBe(1);
    expect(state.fileCommits.at(-1)).toBe("bbbbbbb2xxxx");
    // And what it queued is bound to the new commit.
    expect(await state.precheck!("bbbbbbb2xxxx")).toBeNull();
    expect(await state.precheck!("abc1234def5678")).toContain("another commit");
  });

  test("a recheck with no commit to merge is a stop", async () => {
    const { state, lander } = base();
    await lander.tryLand("p1", "t1");
    expect(await state.precheck!(null)).not.toBeNull();
  });
});
