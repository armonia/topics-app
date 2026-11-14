/**
 * A COMMIT THAT EXISTS IS NOT A COMMIT ON MAIN.
 *
 * Card ccf715f6 (R3): the code was in `~/.claude/jarvis` on the branch
 * `topics/r3-letture`. The card was closed as done, the land of topics-app
 * merged topics-app only, and that branch never reached main. The delivery
 * check verified the sha existed; it never asked where.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { checkReport, type RepoProbe } from "./deliveryReportChecks";
import { probeForRoot } from "./deliveryReportProbe";
import { gitEnv } from "../../tests/setup/bun-test-preload";

const SHA = "ab12cd34ef56";

function probe(over: Partial<RepoProbe>): RepoProbe {
  return {
    shaExists: () => true,
    migrations: () => [],
    fileMatches: () => true,
    readMigration: () => "",
    readLine: () => null,
    symbolInHistory: () => true,
    ...over,
  };
}

describe("sha-off-main con una sonda iniettata", () => {
  test("commit in un altro repo, solo su un ramo: lo dice", () => {
    const p = probe({ shaOffMain: () => ({ repo: "~/.claude/jarvis", branches: ["topics/r3-letture"] }) });
    const f = checkReport(`Fatto, commit ${SHA}.`, p);
    expect(f.map((x) => x.code)).toEqual(["sha-off-main"]);
    expect(f[0]!.detail).toContain("topics/r3-letture");
    expect(f[0]!.detail).toContain("~/.claude/jarvis");
    expect(f[0]!.detail).toContain("non lo porta su main");
  });

  test("nel dubbio nessuna accusa: la sonda che non sa risponde null", () => {
    expect(checkReport(`Fatto, commit ${SHA}.`, probe({ shaOffMain: () => null }))).toEqual([]);
    expect(checkReport(`Fatto, commit ${SHA}.`, probe({}))).toEqual([]);
  });

  test("un commit che non esiste resta sha-missing, non off-main", () => {
    const p = probe({ shaExists: () => false, shaOffMain: () => ({ repo: "x", branches: [] }) });
    expect(checkReport(`Fatto, commit ${SHA}.`, p).map((x) => x.code)).toEqual(["sha-missing"]);
  });
});

describe("sha-off-main con git vero, chiesto in prepare()", () => {
  const g = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf8" }).trim();
  const repo = (dir: string) => {
    g(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "a\n");
    g(dir, "add", "a.txt");
    g(dir, "commit", "-q", "-m", "init");
  };

  test("ramo non unito di un altro repo → accusa; lo stesso commit su main → niente", async () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "off-main-")));
    try {
      const card = join(scratch, "card"); const other = join(scratch, "jarvis");
      execFileSync("mkdir", ["-p", card, other]);
      repo(card); repo(other);
      g(other, "checkout", "-q", "-b", "topics/r3-letture");
      writeFileSync(join(other, "b.txt"), "b\n");
      g(other, "add", "b.txt"); g(other, "commit", "-q", "-m", "r3");
      const sha = g(other, "rev-parse", "HEAD");
      const report = `Fatto in ${other}: commit ${sha}.`;
      const ctx = { homeDirectory: scratch, knownRoots: [other] };

      const before = await probeForRoot(card).prepare!([report], ctx);
      const f = checkReport(report, before);
      expect(f.map((x) => x.code)).toContain("sha-off-main");
      expect(f.find((x) => x.code === "sha-off-main")!.detail).toContain("topics/r3-letture");

      g(other, "checkout", "-q", "main");
      g(other, "merge", "-q", "--ff-only", "topics/r3-letture");
      // Answers are cached per root for 30 s: a fresh probe on a fresh card.
      const card2 = join(scratch, "card2"); execFileSync("mkdir", ["-p", card2]); repo(card2);
      const after = await probeForRoot(card2).prepare!([report], ctx);
      expect(checkReport(report, after).map((x) => x.code)).not.toContain("sha-off-main");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("commit sul ramo del repo della card stesso: nessuna accusa (lo porta il land)", async () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "off-main-own-")));
    try {
      const card = join(scratch, "card"); execFileSync("mkdir", ["-p", card]); repo(card);
      g(card, "checkout", "-q", "-b", "topics/feature");
      writeFileSync(join(card, "b.txt"), "b\n");
      g(card, "add", "b.txt"); g(card, "commit", "-q", "-m", "feat");
      const sha = g(card, "rev-parse", "HEAD");
      const report = `Fatto: commit ${sha}.`;
      const p = await probeForRoot(card).prepare!([report], { homeDirectory: scratch });
      expect(checkReport(report, p).map((x) => x.code)).not.toContain("sha-off-main");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
