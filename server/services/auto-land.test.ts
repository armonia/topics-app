/**
 * The verdict of the automatic land, case by case (`auto-land.ts`).
 * The route-level cases live in `routes/tasks.autoland.test.ts`; here the
 * refusals that need no router: labels, bar coverage, commits, questions.
 *
 * @covers LAND-05
 */
import { describe, expect, test } from "bun:test";
import { autoLandVerdict, createAutoLander, needsAPerson, sameCommit, touchesServer, type AutoLandBoard, type AutoLandCard } from "./auto-land";

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

describe("needsAPerson: a white list, what is not on it stays with a person", () => {
  test.each([
    // The ones the first version let through (verifier, 09/11).
    "landing/index.html", "landing/src/hero.tsx", "client/public/icon.png", "client/index.html",
    "scripts/landing-copy.mjs", "scripts/changelog-i18n.json", "server/attention/compose.ts",
    "server/services/board-actions.ts", "LICENSE", "package.json", "bun.lock",
    // The old black list, still honoured.
    "server/push-triggers.ts", "server/presence.ts", "server/services/discord-presence.ts", "server/views/view-html.ts",
    "shared/tool-detail.ts", "shared/presence-phrase.ts", "desktop-tauri/src-tauri/tauri.conf.json",
    "server/db/migrations/20261109-x.sql", ".github/workflows/ci.yml", "server/routes/agent-channels.ts", "server/lib/stripe.ts",
    // Security, spend, the judge itself and what deletes data (verifier, 09/11, second round).
    "server/lib/auth-gate.ts", "server/lib/device-auth.ts", "server/lib/served-file-headers.ts", "server/services/api-provider-credentials.ts",
    "server/lib/outbound-gate.ts", "server/lib/permission-bridge.ts", "server/lib/topics-secret-path.ts", "server/lib/pairing-quota.ts",
    "server/services/task-dispatcher-spend-cap.ts", "server/services/budget-governor.ts", "server/services/task-dispatcher.ts",
    "server/services/auto-land.ts", "server/services/task-automerge.ts", "server/services/landing-verdict.ts",
    "server/services/own-commits.ts", "server/services/checks-gate.ts", "server/services/review-checks.ts", "server/services/node-delivery-meter.ts",
    "scripts/check-security.ts", "scripts/bloat-baseline.json", "scripts/check-eol.ts", "scripts/gate-board.mjs",
    "server/services/worktree-gc.ts", "server/services/ui-state-purge.ts", "server/lib/kill-agent-tree.ts", "server/services/archive-topic.ts",
    // The database: its shape and the code that runs inside the migrations (note: "migration", not "migrations").
    "server/db/migration-steps.ts", "server/db/migrations-embedded.ts", "server/db/message-tree.ts", "server/db/activity-log.ts",
    // What reads a login or cookies, and the usage that bills.
    "server/browser-site-data.ts", "server/browser-login-state.ts", "server/usage/pricing.ts",
    // A folder nobody listed, and the product text outside the server.
    "newdir/anything.ts", "README.md", "CHANGELOG.md", "client/src/App.tsx", "shared/board.ts", "server.ts",
  ])("%s is not landed alone", (f) => {
    expect(needsAPerson([f])).toEqual([f]);
  });

  test.each([
    "server/services/task-intake.ts", "server/lib/git-numstat.ts", "server/utils/path-env.ts", "docs/board-protocol.md", "openspec/changes/x/proposal.md",
    // Tests are allowed even beside what they test.
    "server/push-triggers.test.ts", "server/services/board-actions.test.ts", "tests/unit/x.test.ts", "scripts/check-eol.test.ts",
  ])("%s lands alone", (f) => {
    expect(needsAPerson([f])).toEqual([]);
  });

  test("one path off the list keeps the whole delivery, and only it is named", () => {
    expect(needsAPerson(["server/lib/git-numstat.ts", "LICENSE", "docs/a.md"])).toEqual(["LICENSE"]);
  });
});

describe("createAutoLander", () => {
  const base = () => {
    const state = {
      card: card(), lands: 0, notes: 0, files: ["server/lib/git-numstat.ts"] as string[] | null, cardLive: false, turns: 0, fileReads: 0,
      precheck: null as null | (() => Promise<string | null>),
    };
    const lander = createAutoLander({
      read: () => ({ task: state.card, comments: [] }),
      board: () => BOARD,
      land: (_p, _t, precheck) => { state.lands += 1; state.precheck = precheck; },
      note: () => { state.notes += 1; },
      files: async () => { state.fileReads += 1; return state.files; },
      liveTurns: async () => state.turns,
      cardTurnLive: () => state.cardLive,
      pollMs: 5,
    });
    return { state, lander };
  };

  test("a delivery touching a path a person must look at is refused", async () => {
    const { state, lander } = base();
    state.files = ["server/push-triggers.ts"];
    expect(await lander.tryLand("p1", "t1")).toBe("refused");
    expect(state.lands).toBe(0);
  });

  test("files that cannot be read refuse the land", async () => {
    const { state, lander } = base();
    state.files = null;
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
    const { state, lander } = base();
    state.files = ["server/lib/git-numstat.ts"];
    state.turns = 1;
    expect(await lander.tryLand("p1", "t1")).toBe("waiting");
    await Bun.sleep(30);
    expect(state.lands).toBe(0);
    state.turns = 0;
    await Bun.sleep(30);
    expect(state.lands).toBe(1);
  });

  test("the land carries a recheck that runs when its turn in the queue comes: card, files, everything again", async () => {
    const { state, lander } = base();
    expect(await lander.tryLand("p1", "t1")).toBe("queued");
    const recheck = state.precheck!;
    expect(await recheck()).toBeNull();
    // Between the ask and the merge (a queue behind other lands) the world moved.
    state.files = ["LICENSE"];
    expect(await recheck()).toContain("LICENSE");
    state.files = ["server/lib/git-numstat.ts"];
    state.card = card({ archived: true });
    expect(await recheck()).not.toBeNull();
    state.card = card({ humanAsk: "guarda" });
    expect(await recheck()).not.toBeNull();
    state.files = null;
    state.card = card();
    expect(await recheck()).not.toBeNull();
  });
});
