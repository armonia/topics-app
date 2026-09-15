/**
 * @covers GATE-11
 *
 * The gate that picks the e2e specs of a change has its own gate.
 *
 * Two failure modes, and they are opposite: pick TOO MANY (the gate becomes the
 * suite and gets switched off) or pick the wrong ones (the gate is green while
 * the spec that measures the change never runs). Both happened while writing
 * it: the first selection linked 5 changed files to 75 specs on tokens like
 * "famil", and the second put eight specs of other features in front of the
 * one that had actually gone red.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { areaTokens, childEnv, nodeIsRecentEnough, ownBundleDir, parseNodeVersion, pickNodeBin, refusesToRunSpecs, selectSpecs, testIdsOf } from "./check-e2e-touched.ts";

const spec = (file: string, text: string) => ({ file: `tests/e2e/${file}`, text });

describe("testIdsOf", () => {
  test("reads the three places a testid is declared, prefix included", () => {
    const ids = testIdsOf(`
      <div data-testid="pane-add-menu" />
      <b data-testid={"identity-row-me"} />
      const row = { testId: \`pane-add-menu-\${agent}\` };
      page.getByTestId("sidebar-board-generale");
    `);
    expect(ids).toContain("pane-add-menu");
    expect(ids).toContain("identity-row-me");
    expect(ids).toContain("pane-add-menu");
    expect(ids).toContain("sidebar-board-generale");
  });

  test("ignores prose and short tokens", () => {
    // `famil${...}` in a sentence is what selected 75 specs on the first run.
    const ids = testIdsOf('const msg = `famil${n === 1 ? "y" : "ies"}`; <i data-testid="ab" />');
    expect(ids).toEqual([]);
  });
});

describe("areaTokens", () => {
  test("the folder and the module name, when they are worth a match", () => {
    expect(areaTokens("client/src/components/Sidebar/TopicItem.tsx")).toEqual(["sidebar", "topicitem"]);
    // `lib` is too short to be a surface: it would match nothing useful.
    expect(areaTokens("client/src/lib/selectionStyles.ts")).toEqual(["selectionstyles"]);
  });
});

describe("selectSpecs", () => {
  const all = [
    spec("sidebar-chevron-column.spec.ts", 'page.locator(\'[role="tree"]\')'),
    spec("share-project.spec.ts", 'getByTestId("project-share")'),
    spec("add-menu.spec.ts", 'import { TERMINAL_AGENT_TYPES } from "../../shared/terminal-session-types";'),
    spec("model-labels.spec.ts", 'import type { Task } from "../../shared/types";'),
  ];

  test("a changed spec is its own reason to run", () => {
    const picked = selectSpecs(["tests/e2e/add-menu.spec.ts"], all);
    expect(picked.map((p) => p.file)).toEqual(["tests/e2e/add-menu.spec.ts"]);
  });

  test("a file nobody imports and no spec names selects nothing", () => {
    expect(selectSpecs(["docs/whatever.md", "package.json"], all)).toEqual([]);
  });

  test("a namesake in another folder is not an import of this one", () => {
    // One name, two files: `server/types.ts` is not `shared/types.ts`.
    // Matching the bare name made a change to the server one pull in
    // every spec importing the shared one, and those reds landed on
    // cards that had never touched it.
    const mine = selectSpecs(["server/types.ts"], all);
    expect(mine.map((p) => p.file)).toEqual([]);
    const real = selectSpecs(["shared/types.ts"], all);
    expect(real.map((p) => p.file)).toEqual(["tests/e2e/model-labels.spec.ts"]);
  });

  test("the area beats a passing testid mention", () => {
    // Both files exist in the repo; the sidebar spec names no testid at all, so
    // only the area can link it, and it has to come first.
    const picked = selectSpecs(["client/src/components/Sidebar/TopicItem.tsx"], all);
    expect(picked[0]?.file).toBe("tests/e2e/sidebar-chevron-column.spec.ts");
  });
});

describe("the Node the gate runs on", () => {
  test("versions parse, and the floor is Vite's", () => {
    expect(parseNodeVersion("v25.9.0\n")).toEqual({ major: 25, minor: 9 });
    expect(parseNodeVersion("")).toBeNull();
    expect(nodeIsRecentEnough({ major: 18, minor: 14 })).toBe(false);
    expect(nodeIsRecentEnough({ major: 20, minor: 18 })).toBe(false);
    expect(nodeIsRecentEnough({ major: 20, minor: 19 })).toBe(true);
    expect(nodeIsRecentEnough({ major: 25, minor: 0 })).toBe(true);
    expect(nodeIsRecentEnough(null)).toBe(false);
  });

  test("a fine PATH is left alone; an old one is replaced by the first fallback that is new enough", () => {
    const table = (m: Record<string, string | null>) => (bin: string) => m[bin] ?? null;
    expect(pickNodeBin(table({ node: "v25.9.0" }), ["/x/node"])).toBeNull();
    expect(pickNodeBin(table({ node: "v18.14.0", "/old/node": "v18.14.0", "/new/node": "v22.12.0" }), ["/old/node", "/new/node"])).toBe("/new/node");
    expect(pickNodeBin(table({ node: "v18.14.0" }), ["/missing/node"])).toBeNull();
  });

  test("the children never inherit NODE_OPTIONS", () => {
    const env = childEnv({ PATH: "/usr/bin", NODE_OPTIONS: "--disable-warning=ExperimentalWarning" });
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("ownBundleDir", () => {
  const main = "/Users/tizio/Projects/topics-app/.git";

  test("the main checkout keeps the watcher's contract: nothing to build", () => {
    expect(ownBundleDir({}, ".git", ".git", "/tmp")).toBeNull();
    expect(ownBundleDir({}, main, main, "/tmp")).toBeNull();
  });

  test("a bundle built elsewhere wins, worktree or not", () => {
    const linked = `${main}/worktrees/sandy-anchor`;
    expect(ownBundleDir({ TOPICS_E2E_BUNDLE_DIR: "/tmp/ci-bundle" }, linked, main, "/tmp")).toBeNull();
  });

  test("a linked worktree builds into a directory named after itself, stable across runs", () => {
    const linked = `${main}/worktrees/sandy-anchor`;
    expect(ownBundleDir({}, linked, main, "/tmp")).toBe("/tmp/topics-e2e-touched/sandy-anchor");
    expect(ownBundleDir({ TOPICS_E2E_BUNDLE_DIR: "  " }, linked, main, "/tmp")).toBe("/tmp/topics-e2e-touched/sandy-anchor");
  });
});

describe("the Mac only lists (15/09/2026: Chromium downloaded onto the owner's Mac)", () => {
  test("refuses only on darwin, outside GitHub Actions, without --list", () => {
    expect(refusesToRunSpecs({ platform: "darwin", githubActions: false, listOnly: false })).toBe(true);
    expect(refusesToRunSpecs({ platform: "darwin", githubActions: false, listOnly: true })).toBe(false);
    expect(refusesToRunSpecs({ platform: "darwin", githubActions: true, listOnly: false })).toBe(false);
    expect(refusesToRunSpecs({ platform: "linux", githubActions: false, listOnly: false })).toBe(false);
    expect(refusesToRunSpecs({ platform: "win32", githubActions: false, listOnly: false })).toBe(false);
  });

  test("the real script in a repo with no node_modules: --list prints, the run exits 97 on a Mac", () => {
    // No node_modules in the temp repo: even with the guard gone no browser can start.
    const dir = mkdtempSync(join(tmpdir(), "e2e-touched-guard-"));
    const script = join(import.meta.dir, "check-e2e-touched.ts");
    const env = { ...process.env, GITHUB_ACTIONS: "", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
      if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
    };
    try {
      git("init", "-q", "-b", "main");
      mkdirSync(join(dir, "tests/e2e"), { recursive: true });
      writeFileSync(join(dir, "tests/e2e/a.spec.ts"), "// v1\n");
      git("add", "-A");
      git("commit", "-q", "-m", "base");
      git("checkout", "-q", "-b", "card");
      writeFileSync(join(dir, "tests/e2e/a.spec.ts"), "// v2\n");
      git("commit", "-q", "-am", "change");
      const run = (...args: string[]) => Bun.spawnSync([process.execPath, script, ...args], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
      const listed = run("--list");
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout.toString()).toContain("tests/e2e/a.spec.ts");
      const ran = run();
      if (process.platform === "darwin") expect(ran.exitCode).toBe(97);
      else expect(ran.exitCode).not.toBe(97);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
