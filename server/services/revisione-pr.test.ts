import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReviewPrompt,
  pendingPrs,
  readRevisionePrConfig,
  reviewKey,
  tickRevisionePr,
  type OpenPr,
  type RevisionePrConfig,
  type RevisionePrDeps,
} from "./revisione-pr";

const pr = (number: number, headRefOid = `sha${number}`): OpenPr => ({
  number,
  title: `PR ${number}`,
  baseRefName: "main",
  headRefOid,
});

describe("readRevisionePrConfig", () => {
  test("is off when repo or workflow is empty", () => {
    expect(readRevisionePrConfig({}, "/data")).toBeNull();
    expect(readRevisionePrConfig({ REVIEW_PR_REPO: "a/b" }, "/data")).toBeNull();
    expect(readRevisionePrConfig({ REVIEW_PR_WORKFLOW: "/w.js" }, "/data")).toBeNull();
  });

  test("reads repo, workflow and a default interval when both are set", () => {
    const cfg = readRevisionePrConfig({ REVIEW_PR_REPO: "a/b", REVIEW_PR_WORKFLOW: "/w.js" }, "/data");
    expect(cfg?.repo).toBe("a/b");
    expect(cfg?.workflowPath).toBe("/w.js");
    expect(cfg?.dataDir).toBe(join("/data", "revisione-pr"));
    expect(cfg?.intervalMs).toBe(10 * 60_000);
  });
});

describe("pendingPrs", () => {
  test("keeps only PRs whose current head has no verdict; a new push asks again", () => {
    const done = new Set([reviewKey(pr(1)), reviewKey(pr(2, "old"))]);
    const open = [pr(1), pr(2, "new"), pr(3)];
    expect(pendingPrs(open, done).map((p) => p.number)).toEqual([2, 3]);
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

describe("tickRevisionePr", () => {
  test("reviews each pending PR once, and skips it on the next pass", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "revisione-pr-"));
    const cfg: RevisionePrConfig = { repo: "a/b", workflowPath: "/w.js", dataDir, intervalMs: 1 };
    const calls: string[] = [];
    const open = [pr(7)];
    const deps: RevisionePrDeps = {
      listOpenPrs: async () => open,
      prepareRefs: async (_clone, _repo, p) => ({ base: "refs/base", head: `refs/pr/${p.number}` }),
      runReview: async (prompt) => {
        calls.push(prompt);
        return '{"findings":[]}';
      },
      log: () => {},
    };

    expect(await tickRevisionePr(cfg, deps)).toEqual([reviewKey(pr(7))]);
    expect(await tickRevisionePr(cfg, deps)).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(await readFile(join(dataDir, "esito-7-sha7.json"), "utf8")).toBe('{"findings":[]}');
  });

  test("a failed review stays pending and is retried on the next pass", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "revisione-pr-"));
    const cfg: RevisionePrConfig = { repo: "a/b", workflowPath: "/w.js", dataDir, intervalMs: 1 };
    let fail = true;
    const deps: RevisionePrDeps = {
      listOpenPrs: async () => [pr(9)],
      prepareRefs: async () => ({ base: "refs/base", head: "refs/pr/9" }),
      runReview: async () => {
        if (fail) throw new Error("claude offline");
        return "ok";
      },
      log: () => {},
    };

    expect(await tickRevisionePr(cfg, deps)).toEqual([]);
    fail = false;
    expect(await tickRevisionePr(cfg, deps)).toEqual([reviewKey(pr(9))]);
  });
});
