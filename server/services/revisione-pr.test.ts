/**
 * Automatic review of newly opened pull requests: empty settings do nothing,
 * the PRs open at switch-on are recorded and not reviewed, one review per
 * tick, confirmed defects open a card in review.
 * @covers PRREVIEW-01
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCard,
  buildReviewPrompt,
  findProjectDirForRepo,
  parseDefects,
  pendingPullRequests,
  readPrReviewConfig,
  repoFromRemoteUrl,
  reviewKey,
  tickPrReview,
  type CardRequest,
  type OpenPr,
  type PrReviewConfig,
  type PrReviewDeps,
} from "./revisione-pr";

const pr = (number: number, headRefOid = `sha${number}`): OpenPr => ({
  number,
  title: `PR ${number}`,
  baseRefName: "main",
  headRefOid,
});

describe("readPrReviewConfig", () => {
  test("is off when repo or workflow is empty", () => {
    expect(readPrReviewConfig({}, "/data")).toBeNull();
    expect(readPrReviewConfig({ REVIEW_PR_REPO: "a/b" }, "/data")).toBeNull();
    expect(readPrReviewConfig({ REVIEW_PR_WORKFLOW: "/w.js" }, "/data")).toBeNull();
  });

  test("reads repo, workflow and a default interval when both are set", () => {
    const cfg = readPrReviewConfig({ REVIEW_PR_REPO: "a/b", REVIEW_PR_WORKFLOW: "/w.js" }, "/data");
    expect(cfg?.repo).toBe("a/b");
    expect(cfg?.workflowPath).toBe("/w.js");
    expect(cfg?.dataDir).toBe(join("/data", "revisione-pr"));
    expect(cfg?.intervalMs).toBe(10 * 60_000);
  });
});

describe("pendingPullRequests", () => {
  test("keeps only PRs whose current head has no verdict; a new push asks again", () => {
    const done = new Set([reviewKey(pr(1)), reviewKey(pr(2, "old"))]);
    const open = [pr(1), pr(2, "new"), pr(3)];
    expect(pendingPullRequests(open, done).map((p) => p.number)).toEqual([2, 3]);
  });
});

describe("buildReviewPrompt", () => {
  test("names the workflow file and passes args as JSON on haiku", () => {
    const prompt = buildReviewPrompt("/w.js", { repo: "/clone", base: "refs/a", head: "refs/b" });
    expect(prompt).toContain("/w.js");
    expect(prompt).toContain('"modello":"haiku"');
    expect(prompt).toContain('"head":"refs/b"');
  });
});

describe("parseDefects", () => {
  test("reads the confirmed defects out of the claude -p envelope", () => {
    const result = 'Ecco:\n```json\n{"reggono":[{"title":"boom","file":"a.ts","line":3}],"nit":[]}\n```';
    expect(parseDefects(JSON.stringify({ type: "result", result }))?.map((d) => d.title)).toEqual(["boom"]);
  });

  test("an empty list is a clean review, unreadable output is not", () => {
    expect(parseDefects(JSON.stringify({ result: '{"reggono":[]}' }))).toEqual([]);
    expect(parseDefects(JSON.stringify({ result: "non ho potuto" }))).toBeNull();
    expect(parseDefects('{"result":"{\\"altro\\":1}"}')).toBeNull();
  });
});

describe("repo to project", () => {
  test("reads owner/name from https and ssh remotes", () => {
    expect(repoFromRemoteUrl("https://github.com/Own/Name.git")).toBe("Own/Name");
    expect(repoFromRemoteUrl("git@github.com:own/name.git")).toBe("own/name");
    expect(repoFromRemoteUrl("https://github.com/own/name")).toBe("own/name");
  });

  test("finds the directory whose origin is the repo, ignoring case", async () => {
    const remotes: Record<string, string | null> = { "/p/a": "git@github.com:x/y.git", "/p/b": "https://github.com/Own/Name.git", "/p/c": null };
    const remoteOf = async (d: string) => remotes[d] ?? null;
    expect(await findProjectDirForRepo("own/name", ["/p/a", "/p/c", "/p/b"], remoteOf)).toBe("/p/b");
    expect(await findProjectDirForRepo("own/none", ["/p/a", "/p/b"], remoteOf)).toBeNull();
  });
});

describe("buildCard", () => {
  test("links the PR and lists every defect", () => {
    const card = buildCard("a/b", pr(5), [{ title: "boom", file: "x.ts", line: 9, scenario: "when empty" }], "/out/esito.json");
    expect(card.description).toContain("https://github.com/a/b/pull/5");
    expect(card.description).toContain("boom (x.ts:9)");
    expect(card.description).toContain("when empty");
    expect(card.idempotencyKey).toBe("revisione-pr:a/b:5@sha5");
  });
});

async function harness(options: { board?: boolean } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "revisione-pr-"));
  const cfg: PrReviewConfig = { repo: "a/b", workflowPath: "/w.js", dataDir, intervalMs: 1 };
  const state = { open: [] as OpenPr[], reviews: [] as string[], cards: [] as CardRequest[], answer: '{"result":"{\\"reggono\\":[]}"}', fail: false };
  const deps: PrReviewDeps = {
    listOpenPrs: async () => state.open,
    prepareRefs: async (_clone, _repo, p) => ({ base: "base-sha", head: `refs/pr/${p.number}` }),
    runReview: async (prompt) => {
      state.reviews.push(prompt);
      if (state.fail) throw new Error("claude offline");
      return state.answer;
    },
    hasBoard: async () => options.board ?? true,
    openCard: async (card) => {
      state.cards.push(card);
    },
    log: () => {},
  };
  return { cfg, state, deps };
}

describe("tickPrReview", () => {
  test("first pass records the open PRs as seen and reviews none of them", async () => {
    const { cfg, state, deps } = await harness();
    state.open = [pr(1), pr(2)];
    expect(await tickPrReview(cfg, deps)).toEqual([]);
    expect(state.reviews).toHaveLength(0);
    const saved = JSON.parse(await readFile(join(cfg.dataDir, "reviewed.json"), "utf8"));
    expect(saved.done).toEqual([reviewKey(pr(1)), reviewKey(pr(2))]);
    expect(await tickPrReview(cfg, deps)).toEqual([]);
    expect(state.reviews).toHaveLength(0);
  });

  test("after switch-on a new PR and a new push are reviewed, one per tick", async () => {
    const { cfg, state, deps } = await harness();
    state.open = [pr(1)];
    await tickPrReview(cfg, deps);
    state.open = [pr(1, "pushed"), pr(2), pr(3)];
    expect(await tickPrReview(cfg, deps)).toEqual([reviewKey(pr(1, "pushed"))]);
    expect(await tickPrReview(cfg, deps)).toEqual([reviewKey(pr(2))]);
    expect(await tickPrReview(cfg, deps)).toEqual([reviewKey(pr(3))]);
    expect(await tickPrReview(cfg, deps)).toEqual([]);
    expect(state.reviews).toHaveLength(3);
    expect(state.reviews[0]).toContain('"base":"base-sha"');
  });

  test("confirmed defects open a card; a clean review only leaves the verdict file", async () => {
    const { cfg, state, deps } = await harness();
    await tickPrReview(cfg, deps);
    state.open = [pr(4)];
    await tickPrReview(cfg, deps);
    expect(state.cards).toHaveLength(0);
    expect(await readFile(join(cfg.dataDir, "esito-4-sha4.json"), "utf8")).toBe(state.answer);

    state.open = [pr(4), pr(5)];
    state.answer = JSON.stringify({ result: '{"reggono":[{"title":"boom"}]}' });
    await tickPrReview(cfg, deps);
    expect(state.cards).toHaveLength(1);
    expect(state.cards[0].description).toContain("pull/5");
  });

  test("a PR waits, unreviewed, while no board project owns the repo", async () => {
    const { cfg, state, deps } = await harness({ board: false });
    await tickPrReview(cfg, deps);
    state.open = [pr(6)];
    expect(await tickPrReview(cfg, deps)).toEqual([]);
    expect(state.reviews).toHaveLength(0);
  });

  test("a failing review is retried, then given up so it cannot block the others", async () => {
    const { cfg, state, deps } = await harness();
    await tickPrReview(cfg, deps);
    state.open = [pr(9)];
    state.fail = true;
    for (let i = 0; i < 3; i++) expect(await tickPrReview(cfg, deps)).toEqual([]);
    expect(state.reviews).toHaveLength(3);
    state.fail = false;
    expect(await tickPrReview(cfg, deps)).toEqual([]);
    expect(state.reviews).toHaveLength(3);
    state.open = [pr(9), pr(10)];
    expect(await tickPrReview(cfg, deps)).toEqual([reviewKey(pr(10))]);
  });
});
