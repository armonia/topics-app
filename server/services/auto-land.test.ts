/**
 * The verdict of the automatic land, case by case (`auto-land.ts`).
 * The route-level cases live in `routes/tasks.autoland.test.ts`; here the
 * refusals that need no router: labels, bar coverage, commits, questions.
 *
 * @covers LAND-05, LAND-17
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PersonPath } from "../../shared/workflow";
import {
  autoLandVerdict, classifyDelivery, createAutoLander, mayLandAloneByPlace, personPlace, sameCommit, touchesServer,
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

  test("a card in AI review is closed by its opener", () => {
    expect(verdict(card({ stage: "ai_review" })).ok).toBe(false);
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

describe("mayLandAloneByPlace / classifyDelivery: technical code lands alone, a person's places do not", () => {
  test.each([
    "docs/board-protocol.md", "openspec/changes/x/proposal.md",
    "server/lib/git-numstat.test.ts", "server/push-triggers.test.ts", "client/src/state/board.test.tsx",
    "tests/unit/x.test.ts", "tests/integration/migration-071.test.ts", "tests/e2e/board.spec.ts", "tests/e2e/deep/a.spec.ts",
    // Technical code (owner's rule 09/11): it lands once the whole bar is green on the commit that lands.
    "server/lib/git-numstat.ts", "server/lib/serial-queue.ts", "server/services/task-dispatcher.ts", "server/routes/notes.ts",
    "server/db/schema.ts", "server/db/migrations/20261109-x.sql", "shared/tool-detail.ts",
    "server/services/project-store.ts", "newdir/anything.ts",
  ])("%s lands alone", (f) => {
    expect(mayLandAloneByPlace(f)).toBe(true);
    expect(classifyDelivery([f])).toEqual({ tier: "alone", files: [] });
  });

  test.each([
    // What a person sees, in any repository.
    ["client/src/App.tsx", "interface"], ["landing/index.html", "interface"], ["web/styles/site.css", "interface"], ["README.md", "public text"], ["LICENSE", "public text"],
    // What reaches a person or a third party.
    ["server/push-triggers.ts", "reaches a person"], ["server/presence.ts", "reaches a person"], ["server/services/discord-presence.ts", "reaches a person"],
    ["server/routes/notifications.ts", "reaches a person"], ["server/routes/agent-channels.ts", "reaches a person"], ["server/routes/voice.ts", "reaches a person"],
    // Security and money.
    ["server/lib/authGate.ts", "security or money"], ["server/lib/agent-env.ts", "security or money"], ["server/lib/child-env.ts", "security or money"],
    ["server/lib/session-token.ts", "security or money"], ["server/lib/stripe.ts", "security or money"], ["server/usage/pricing.ts", "security or money"],
    ["server/services/relay-client.ts", "security or money"], ["server/lib/licenza.ts", "security or money"],
    // Dependencies and the runner, whatever the language.
    ["package.json", "dependencies or runner"], ["bun.lock", "dependencies or runner"], ["bunfig.toml", "dependencies or runner"],
    ["desktop-tauri/src-tauri/Cargo.toml", "dependencies or runner"], ["api/go.mod", "dependencies or runner"], ["requirements-dev.txt", "dependencies or runner"],
    // The judge: the CI and the snapshots.
    [".github/workflows/ci.yml", "the judge"], [".github/scripts/x.test.ts", "the judge"], [".gitlab-ci.yml", "the judge"],
    ["tests/unit/__snapshots__/x.snap", "the judge"], ["tests/e2e/board.spec.ts-snapshots/a.png", "the judge"],
    // Words on any segment of the path.
    ["server/providers/claude-cloud/creds.ts", "security or money"], ["server/lib/permission-bridge.ts", "security or money"],
  ])("%s is a person's on any board (%s)", (f, why) => {
    expect(personPlace(f)).toBe(why);
    expect(classifyDelivery([f])).toEqual({ tier: "person", files: [f] });
  });

  // THIS repository's own paths come from its board's workflow rules, not from the code.
  const TOPICS = (JSON.parse(readFileSync(join(import.meta.dir, "../../docs/board-workflow-rules.json"), "utf8")) as { personPaths: PersonPath[] }).personPaths;
  test.each([
    ["client/src/lib/board.ts", "interface"], ["landing/vite.config.ts", "public site"],
    ["scripts/check-security.ts", "the judge"], ["tests/setup/bun-test-preload.ts", "the judge"], ["tests/e2e/global-setup.ts", "the judge"],
    ["tests/helpers/time-slack.ts", "the judge"], ["tests/fixtures/repo.ts", "the judge"], ["tests/unit/data.json", "the judge"], ["docs/schema.json", "the judge"],
    ["server/services/auto-land.ts", "the judge"], ["server/services/red-bounce.ts", "the judge"], ["server/services/review-checks.ts", "the judge"],
    ["shared/task-labels.ts", "the judge"], ["shared/workflow.ts", "the judge"], ["shared/board.ts", "the judge"], ["server.ts", "the judge"],
    ["server/routes/tasks.ts", "the judge"], ["server/routes/tasks-ci-phase.ts", "the judge"], ["server/services/integration-measure.ts", "the judge"],
    ["server/services/landing-files.ts", "the judge"], ["server/services/task-automerge.ts", "the judge"], ["server/services/node-delivery-meter.ts", "the judge"],
    ["server/services/land-attribution-gate.ts", "the judge"], ["server/services/ci-supersede.ts", "the judge"], ["server/services/board-workflow.ts", "the judge"],
    ["desktop-tauri/src-tauri/src/lib.rs", "release or infrastructure"], ["native/src/lib.rs", "release or infrastructure"],
    ["deploy/cloud-node/user-data.sh.tmpl", "release or infrastructure"],
  ])("%s is a person's on the topics-app board (%s), and nowhere else", (f, why) => {
    expect(personPlace(f, TOPICS)).toBe(why);
    expect(personPlace(f)).toBeNull();
    expect(classifyDelivery([f], new Set(), TOPICS)).toEqual({ tier: "person", files: [f] });
  });

  test("a test is a test even under a board's path: only the CI's own folder holds its tests", () => {
    for (const f of ["client/src/state/board.test.tsx", "tests/e2e/board.spec.ts", "scripts/check-eol.test.ts"]) {
      expect(personPlace(f, TOPICS)).toBeNull();
    }
  });

  test("a test file or a document that the bar's configuration NAMES is the judge, not a test", () => {
    const loaded = "tests/unit/helpers/preload-extra.test.ts";
    expect(classifyDelivery([loaded]).tier).toBe("alone");
    expect(classifyDelivery([loaded], new Set([loaded]))).toEqual({ tier: "person", files: [loaded] });
    expect(classifyDelivery(["docs/board-protocol.md", "docs/a.md"], new Set(["docs/board-protocol.md"])).files).toEqual(["docs/board-protocol.md"]);
  });

  test("the delivery is a person's as soon as one file is, and the files that make it so are named", () => {
    expect(classifyDelivery(["docs/a.md", "server/lib/git-numstat.ts"]).tier).toBe("alone");
    expect(classifyDelivery(["server/lib/git-numstat.ts", "client/src/App.tsx", "docs/a.md"])).toEqual({ tier: "person", files: ["client/src/App.tsx"] });
    expect(classifyDelivery(["server/push-service.ts", "LICENSE", "docs/a.md"])).toEqual({ tier: "person", files: ["server/push-service.ts", "LICENSE"] });
  });

  test("an empty diff has nothing a person must read", () => {
    expect(classifyDelivery([]).tier).toBe("alone");
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
      /** The board's own paths (its workflow rules); `null` = they cannot be read. */
      boardPaths: [] as PersonPath[] | null,
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
      liveTurns: async (how) => { state.turnAsks.push(how); return state.turns; },
      cardTurnLive: () => state.cardLive,
      personPaths: () => { if (state.boardPaths === null) throw new Error("unreadable"); return state.boardPaths; },
      pollMs: 5,
    });
    return { state, lander };
  };
  /** The commit the default card delivers and the bar measured. */
  const OFFERED = "abc1234def5678";
  /** A delivery of tests that sits inside `server/`: it lands alone, and it reloads the live server. */
  const serverTest = ["server/lib/git-numstat.test.ts"];

  test("a delivery touching a path a person must look at is refused", async () => {
    const { state, lander } = base({ files: ["server/push-triggers.ts"] });
    expect(await lander.tryLand("p1", "t1")).toBe("refused");
    expect(state.lands).toBe(0);
  });

  test("a path the BOARD names is a person's on that board: refused; paths that cannot be read refuse too", async () => {
    const { state, lander } = base({ files: ["server/lib/git-numstat.ts"] });
    state.boardPaths = [{ pattern: "server/lib/**", why: "this board" }];
    expect(await lander.tryLand("p1", "t1")).toBe("refused");
    state.boardPaths = null;
    expect(await lander.tryLand("p1", "t1")).toBe("refused");
    expect(state.lands).toBe(0);
    state.boardPaths = [];
    expect(await lander.tryLand("p1", "t1")).toBe("queued");
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

  // The line `AI-REVIEW approved <sha>` is a comment, and a comment is signed by whatever session the URL names: it proves nothing.
  test("a person's place stays a person's even with an approval line of another model family on this very commit", async () => {
    const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const approval: AutoLandComment = {
      author: "agent:r1", kind: "comment", createdAt: "2026-11-09T11:00:00.000Z",
      content: `AI-REVIEW approved ${sha}\nLetto il diff: nessun effetto fuori dai test.`,
    };
    const delivered = (stage: string | null) => card({ stage, deliveryCommit: sha, checksCommit: sha });
    // Control: the same card and the same line, with text, lands: the refusals below come from the paths.
    const control = base({ files: ["docs/a.md"], card: delivered(null), thread: [approval] });
    expect(await control.lander.tryLand("p1", "t1")).toBe("queued");
    for (const stage of ["ai_review", "human_review", null]) {
      const { state, lander } = base({ files: ["server/push-triggers.ts"], card: delivered(stage), thread: [approval] });
      expect(await lander.tryLand("p1", "t1")).toBe("refused");
      expect(state.lands).toBe(0);
    }
  });

  test("text in a card sitting in AI review is still closed by its opener", async () => {
    const { state, lander } = base({ files: ["docs/note.md"], card: card({ stage: "ai_review" }) });
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
    const { state, lander } = base({ files: serverTest });
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
    const { state, lander } = base({ files: serverTest });
    expect(await lander.tryLand("p1", "t1")).toBe("queued");
    state.turnAsks.length = 0;
    // The card's agent woke up and three turns are open when the queue hands over.
    state.cardLive = true; state.turns = 3;
    const stop = await state.precheck!(OFFERED);
    expect(stop).toContain("turn");
    expect(state.turnAsks).toEqual([]); // the card's own turn is enough: no need to count the others
    state.cardLive = false;
    expect(await state.precheck!(OFFERED)).toContain("turn");
    // It asked the count as a land asking about itself: its own slot in the queue is not a turn to wait for.
    expect(state.turnAsks).toEqual([{ insideLand: true }]);
    state.turns = 0;
    expect(await state.precheck!(OFFERED)).toBeNull();
  });

  test("a land stopped on a turn is asked again by the next sweep, not refused as 'already offered'", async () => {
    const { state, lander } = base({ files: serverTest });
    expect(await lander.tryLand("p1", "t1")).toBe("queued");
    state.turns = 2;
    expect(await state.precheck!(OFFERED)).toContain("turn");
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
