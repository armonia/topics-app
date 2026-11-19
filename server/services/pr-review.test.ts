import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PR_REVIEW_DEFAULTS,
  resolvePrReviewSettings,
  stateKey,
  tickPrReview,
  type OpenPullRequest,
  type PrReviewDeps,
  type PrReviewRun,
  type PrReviewState,
} from "./pr-review";

const REPO = "owner/example";
const PR: OpenPullRequest = {
  number: 7,
  title: "feat: something",
  baseRefName: "main",
  headRefName: "feature",
  headRefOid: "abc123",
};

function fakeDeps(prs: OpenPullRequest[], initial: PrReviewState = {}) {
  const runs: PrReviewRun[] = [];
  let state: PrReviewState = { ...initial };
  const root = mkdtempSync(join(tmpdir(), "pr-review-test-"));
  const deps: PrReviewDeps = {
    rootDir: root,
    now: () => new Date("2026-11-18T10:00:00Z"),
    log: () => {},
    loadState: () => state,
    saveState: (next) => {
      state = next;
    },
    listOpenPullRequests: async () => prs,
    prepareClone: async () => {},
    runReview: async (run) => {
      runs.push(run);
      return JSON.stringify({ reggono: [], confutati: [] });
    },
  };
  return { deps, runs, getState: () => state, root };
}

const ON = { ...PR_REVIEW_DEFAULTS, repo: REPO, workflowPath: "/tmp/revisione-pr.js" };

describe("pr-review tick", () => {
  test("with an empty repo the tick does nothing and lists nothing", async () => {
    const { deps, runs } = fakeDeps([PR]);
    let listed = false;
    deps.listOpenPullRequests = async () => {
      listed = true;
      return [PR];
    };
    const launched = await tickPrReview({ ...PR_REVIEW_DEFAULTS }, deps);
    expect(launched).toEqual([]);
    expect(runs.length).toBe(0);
    expect(listed).toBe(false);
  });

  test("with an empty workflow path the tick does nothing", async () => {
    const { deps, runs } = fakeDeps([PR]);
    const launched = await tickPrReview({ ...PR_REVIEW_DEFAULTS, repo: REPO }, deps);
    expect(launched).toEqual([]);
    expect(runs.length).toBe(0);
  });

  test("a PR already in the state is not reviewed again", async () => {
    const key = stateKey(REPO, PR);
    const { deps, runs } = fakeDeps([PR], { [key]: { status: "done", at: "2026-11-17T10:00:00Z" } });
    const launched = await tickPrReview(ON, deps);
    expect(launched).toEqual([]);
    expect(runs.length).toBe(0);
  });

  test("a new PR launches one review and records it", async () => {
    const { deps, runs, getState, root } = fakeDeps([PR]);
    const launched = await tickPrReview(ON, deps);
    expect(launched).toEqual([stateKey(REPO, PR)]);
    expect(runs.length).toBe(1);
    expect(runs[0].base).toBe("origin/main");
    expect(runs[0].head).toBe("abc123");
    expect(runs[0].model).toBe("haiku");
    expect(getState()[stateKey(REPO, PR)].status).toBe("done");
    expect(existsSync(runs[0].outFile)).toBe(true);
    expect(JSON.parse(readFileSync(runs[0].outFile, "utf8"))).toEqual({ reggono: [], confutati: [] });
    expect(runs[0].outFile.startsWith(root)).toBe(true);
  });

  test("a new commit on a reviewed PR is a new review", async () => {
    const old = stateKey(REPO, { ...PR, headRefOid: "old000" });
    const { deps, runs } = fakeDeps([PR], { [old]: { status: "done", at: "x" } });
    await tickPrReview(ON, deps);
    expect(runs.length).toBe(1);
  });

  test("a failed review is recorded and not retried on the next tick", async () => {
    const { deps, runs, getState } = fakeDeps([PR]);
    deps.runReview = async (run) => {
      runs.push(run);
      throw new Error("claude exited 1");
    };
    await tickPrReview(ON, deps);
    expect(getState()[stateKey(REPO, PR)].status).toBe("failed");
    await tickPrReview(ON, deps);
    expect(runs.length).toBe(1);
  });

  test("a failing PR list returns nothing and does not throw", async () => {
    const { deps, runs } = fakeDeps([PR]);
    deps.listOpenPullRequests = async () => {
      throw new Error("gh: not logged in");
    };
    expect(await tickPrReview(ON, deps)).toEqual([]);
    expect(runs.length).toBe(0);
  });
});

describe("pr-review settings", () => {
  test("defaults are empty, so the feature is off", () => {
    const s = resolvePrReviewSettings({});
    expect(s.repo).toBe("");
    expect(s.workflowPath).toBe("");
    expect(s.model).toBe("haiku");
    expect(s.intervalMinutes).toBe(15);
  });

  test("environment overrides apply and a bad interval falls back", () => {
    const s = resolvePrReviewSettings({
      TOPICS_PR_REVIEW_REPO: REPO,
      TOPICS_PR_REVIEW_INTERVAL_MINUTES: "0",
    });
    expect(s.repo).toBe(REPO);
    expect(s.intervalMinutes).toBe(15);
  });
});
