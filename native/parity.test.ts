/** @covers D3C-01 */
/** @covers D3D-01 */
/** @covers D3F-02 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, symlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gitEnv } from "../tests/setup/bun-test-preload";
import { parseBranchHeader, splitBranchHeader } from "../server/lib/git-status";
import { parsePorcelainZ, repoPrefixOf, scopeToPrefix } from "../server/lib/git-porcelain";
import { parseNumstatZ } from "../server/lib/git-numstat";
import { loadNativeModuleAt } from "../server/lib/native-addon";
import { walkFileTreeJs } from "../server/lib/file-tree";
import { percentile } from "../scripts/measure-file-tree";

const addonPath = resolve(process.env.TOPICS_NATIVE_ADDON_PATH ?? resolve(import.meta.dir, "topics_native.node"));
const native = Bun.file(addonPath).size ? loadNativeModuleAt(addonPath) : null;
const gitStatus = native?.gitStatus;
const gitNumstat = native?.gitNumstat;
const nativeWalkFileTree = native?.walkFileTree;

test("file-tree measurement uses the median pair and nearest-rank p95", () => {
  expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
  expect(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 0.95)).toBe(19);
});

if (!gitStatus) console.log("SKIP native git status parity: build-native-addon.sh has not run");

type Fixture = { root: string; cwd?: string };

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { env: gitEnv() });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

function write(root: string, path: string, content = "fixture\n"): void {
  const file = join(root, path);
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

function init(root: string, initial: Record<string, string> = {}): void {
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Fixture Author");
  git(root, "config", "user.email", "fixture@example.invalid");
  for (const [path, content] of Object.entries(initial)) write(root, path, content);
  if (Object.keys(initial).length) {
    git(root, "add", "-A");
    git(root, "commit", "-qm", "fixture commit");
  }
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "native-git-parity-"));
}

async function parity(root: string, cwd = root): Promise<void> {
  if (!gitStatus) return;
  const probe = git(cwd, "rev-parse", "--git-dir", "--show-toplevel").trim().split("\n");
  const rootPath = probe[1];
  const statusText = git(cwd, "--no-optional-locks", "status", "--porcelain", "-z", "--branch");
  const { header, entries: rawEntries } = splitBranchHeader(statusText);
  const branchInfo = header ? parseBranchHeader(header) : { branch: null, ahead: 0, behind: 0 };
  const logResult = Bun.spawnSync(["git", "-C", cwd, "log", "-1", "--format=%h|%H|%s|%an|%at"], { env: gitEnv() });
  const logText = logResult.exitCode === 0 ? logResult.stdout.toString().trim() : "";
  const [short = "", hash = "", subject = "", author = "", time = "0"] = logText ? logText.split("|") : [];
  const expected = {
    root: rootPath,
    branch: branchInfo.branch,
    ahead: branchInfo.ahead,
    behind: branchInfo.behind,
    entries: parsePorcelainZ(rawEntries),
    lastCommit: logText ? { short, hash, subject, author, time: Number(time) } : null,
  };
  const actual = await gitStatus(cwd);
  expect(actual).toEqual(expected);
  if (!gitNumstat) return;
  const scope = repoPrefixOf(cwd, rootPath);
  const scopedEntries = scopeToPrefix(actual.entries, scope.prefix);
  const scopedPaths = new Set(scopedEntries.map(({ path }) => scope.prefix + path));
  const actualNumstat = await gitNumstat(cwd, actual.entries.filter(({ path }) => scopedPaths.has(path)));
  const parseNative = (entries: typeof actualNumstat.staged) => new Map(entries.map(({ path, added, removed, binary }) => [path, binary ? { added: 0, removed: 0, binary: true } : { added, removed }]));
  const fallbackPaths = actualNumstat.unsupported;
  const fallback = (cached: boolean) => fallbackPaths.length
    ? parseNumstatZ(git(cwd, "--literal-pathspecs", "diff", ...(cached ? ["--cached"] : []), "--numstat", "-z", "--", ...fallbackPaths))
    : new Map();
  const merge = (left: Map<string, { added: number; removed: number; binary?: boolean }>, right: Map<string, { added: number; removed: number; binary?: boolean }>) => {
    for (const [path, stat] of right) left.set(path, stat);
    return left;
  };
  const staged = merge(parseNative(actualNumstat.staged), fallback(true));
  const unstaged = merge(parseNative(actualNumstat.unstaged), fallback(false));
  const expectedNumstat = (cached: boolean) => new Map(
    [...parseNumstatZ(git(cwd, "diff", ...(cached ? ["--cached"] : []), "--numstat", "-z"))]
      .filter(([path]) => !scope.prefix || path.startsWith(scope.prefix)),
  );
  expect(staged).toEqual(expectedNumstat(true));
  expect(unstaged).toEqual(expectedNumstat(false));
}

const scenarios: Array<[string, (root: string) => Promise<void> | void, string?]> = [
  ["clean repository with aligned upstream", (root) => { init(root, { "tracked.txt": "same\n" }); git(root, "update-ref", "refs/remotes/origin/main", "HEAD"); git(root, "config", "branch.main.remote", "origin"); git(root, "config", "branch.main.merge", "refs/heads/main"); }],
  ["worktree modification", (root) => { init(root, { "tracked.txt": "before\n" }); write(root, "tracked.txt", "after\n"); }],
  ["index modification", (root) => { init(root, { "tracked.txt": "before\n" }); write(root, "tracked.txt", "after\n"); git(root, "add", "tracked.txt"); }],
  ["staged and unstaged modification", (root) => { init(root, { "tracked.txt": "before\n" }); write(root, "tracked.txt", "staged\n"); git(root, "add", "tracked.txt"); write(root, "tracked.txt", "unstaged\n"); }],
  ["added index file and worktree edit", (root) => { init(root); write(root, "added.txt", "added\n"); git(root, "add", "added.txt"); write(root, "added.txt", "edited\n"); }],
  ["worktree and staged deletion", (root) => { init(root, { "worktree.txt": "a\n", "staged.txt": "b\n" }); rmSync(join(root, "worktree.txt")); rmSync(join(root, "staged.txt")); git(root, "add", "staged.txt"); }],
  ["staged rename and rename with later modification", (root) => { init(root, { "old.txt": "same body\n", "second.txt": "old\n" }); renameSync(join(root, "old.txt"), join(root, "new.txt")); git(root, "add", "-A"); renameSync(join(root, "second.txt"), join(root, "second-new.txt")); git(root, "add", "-A"); write(root, "second-new.txt", "different\n"); }],
  ["worktree file changed to symlink (skipped on Windows: symlink capability)", (root) => { init(root, { "target": "target\n", "link": "plain\n" }); if (process.platform !== "win32") { rmSync(join(root, "link")); symlinkSync("target", join(root, "link")); } }, "symlinks are not portable in Windows CI without elevated link privileges"],
  ["executable bit changed (skipped on Windows: mode bit)", (root) => { init(root, { "run.sh": "#!/bin/sh\n", "staged.sh": "#!/bin/sh\n" }); if (process.platform !== "win32") { chmodSync(join(root, "run.sh"), 0o755); chmodSync(join(root, "staged.sh"), 0o755); git(root, "add", "staged.sh"); } }, "Windows file modes do not expose the executable bit used by Git"],
  ["intent to add", (root) => { init(root); write(root, "intent.txt"); git(root, "add", "-N", "intent.txt"); }],
  ["single untracked file", (root) => { init(root); write(root, "untracked.txt"); }],
  ["collapsed untracked directory", (root) => { init(root); write(root, "dir/one.txt"); write(root, "dir/two.txt"); }],
  ["showUntrackedFiles all and no", async (root) => { init(root); git(root, "config", "status.showUntrackedFiles", "all"); write(root, "dir/one.txt"); write(root, "dir/two.txt"); await parity(root); git(root, "config", "status.showUntrackedFiles", "no"); }],
  ["nested ignore files, info exclude, and negation", (root) => { init(root, { ".gitignore": "ignored-root.txt\n", "sub/.gitignore": "*.tmp\n!keep.tmp\n" }); write(root, ".git/info/exclude", "ignored-local.txt\n"); write(root, "ignored-root.txt"); write(root, "ignored-local.txt"); write(root, "sub/drop.tmp"); write(root, "sub/keep.tmp"); }],
  ["ignored directory containing tracked file", (root) => { init(root, { "keep/file.txt": "tracked\n", ".gitignore": "keep/\n!keep/file.txt\n" }); write(root, "keep/file.txt", "changed\n"); }],
  ["UU and AA merge conflicts", (root) => { init(root, { "uu.txt": "base\n", "aa.txt": "base\n" }); git(root, "checkout", "-qb", "side"); write(root, "uu.txt", "side\n"); git(root, "rm", "-q", "aa.txt"); write(root, "aa.txt", "side add\n"); git(root, "add", "-A"); git(root, "commit", "-qm", "side"); git(root, "checkout", "-q", "main"); write(root, "uu.txt", "main\n"); git(root, "rm", "-q", "aa.txt"); write(root, "aa.txt", "main add\n"); git(root, "add", "-A"); git(root, "commit", "-qm", "main change"); const result = Bun.spawnSync(["git", "-C", root, "merge", "side"], { env: gitEnv() }); if (result.exitCode !== 1) throw new Error("expected merge conflict"); }],
  ["DU and UD merge conflicts", (root) => { init(root, { "du.txt": "base\n", "ud.txt": "base\n" }); git(root, "checkout", "-qb", "side"); rmSync(join(root, "du.txt")); write(root, "ud.txt", "side\n"); git(root, "add", "-A"); git(root, "commit", "-qm", "side"); git(root, "checkout", "-q", "main"); write(root, "du.txt", "main\n"); rmSync(join(root, "ud.txt")); git(root, "add", "-A"); git(root, "commit", "-qm", "main change"); const result = Bun.spawnSync(["git", "-C", root, "merge", "side"], { env: gitEnv() }); if (result.exitCode !== 1) throw new Error("expected merge conflict"); }],
  ["submodule with new commit", async (root) => { const child = join(root, "..", "child-repo"); init(child, { "file.txt": "one\n" }); init(root); git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "sub"); git(root, "commit", "-qm", "add submodule"); write(join(root, "sub"), "file.txt", "two\n"); git(join(root, "sub"), "add", "-A"); git(join(root, "sub"), "-c", "user.name=Fixture Author", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "child commit"); }],
  ["submodule with modified and untracked content", async (root) => { const child = join(root, "..", "child-repo"); init(child, { "file.txt": "one\n" }); init(root); git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "sub"); git(root, "commit", "-qm", "add submodule"); write(join(root, "sub"), "file.txt", "two\n"); write(join(root, "sub"), "loose.txt"); }],
  ["cone-mode sparse checkout", (root) => { init(root, { "keep/a.txt": "a\n", "skip/b.txt": "b\n" }); git(root, "sparse-checkout", "init", "--cone"); git(root, "sparse-checkout", "set", "keep"); write(root, "keep/a.txt", "changed\n"); }],
  ["linked worktree", (root) => { init(root, { "tracked.txt": "tracked\n" }); git(root, "worktree", "add", "-qb", "linked", join(root, "..", "linked")); }],
  ["detached HEAD", (root) => { init(root, { "tracked.txt": "tracked\n" }); git(root, "checkout", "--detach", "-q", "HEAD"); }],
  ["unborn branch", (root) => init(root)],
  ["upstream ahead and behind", (root) => { init(root, { "tracked.txt": "base\n" }); git(root, "checkout", "-qb", "upstream-tip"); write(root, "remote.txt"); git(root, "add", "remote.txt"); git(root, "commit", "-qm", "remote"); git(root, "update-ref", "refs/remotes/origin/main", "HEAD"); git(root, "checkout", "-q", "main"); write(root, "local.txt"); git(root, "add", "local.txt"); git(root, "commit", "-qm", "local"); git(root, "config", "branch.main.remote", "origin"); git(root, "config", "branch.main.merge", "refs/heads/main"); }],
  ["upstream marked gone", (root) => { init(root, { "tracked.txt": "base\n" }); git(root, "config", "branch.main.remote", "origin"); git(root, "config", "branch.main.merge", "refs/heads/missing"); }],
  ["LFS clean filter with touched-equal and modified files", (root) => { init(root, { ".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n", "clean.bin": "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n", "changed.bin": "version https://git-lfs.github.com/spec/v1\noid sha256:def\nsize 1\n" }); git(root, "config", "filter.lfs.clean", "cat"); git(root, "config", "filter.lfs.smudge", "cat"); write(root, "clean.bin", "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n"); write(root, "changed.bin", "changed\n"); }],
  ["spaces and NFC/NFD file names; newline skipped on Windows", (root) => { init(root); write(root, "space name.txt"); write(root, "café.txt"); write(root, "cafe\u0301.txt"); if (process.platform !== "win32") write(root, "line\nname.txt"); else console.log("SKIP newline filename: Windows does not support newlines in file names"); }],
  ["status queried from a subdirectory", async (root) => { init(root, { "sub/file.txt": "before\n", "other.txt": "before\n" }); write(root, "sub/file.txt", "after\n"); write(root, "other.txt", "after\n"); await parity(root, join(root, "sub")); }],
  ["assume-unchanged and skip-worktree", (root) => { init(root, { "assume.txt": "a\n", "skip.txt": "b\n" }); git(root, "update-index", "--assume-unchanged", "assume.txt"); git(root, "update-index", "--skip-worktree", "skip.txt"); write(root, "assume.txt", "changed\n"); write(root, "skip.txt", "changed\n"); }],
  ["CRLF normalization via text=auto and autocrlf", (root) => { init(root, { ".gitattributes": "*.txt text=auto\n", "line.txt": "one\ntwo\n" }); git(root, "config", "core.autocrlf", "true"); write(root, "line.txt", "one\r\ntwo\r\n"); }],
  ["binary file", (root) => { init(root, { "image.bin": "before\0bytes\n" }); write(root, "image.bin", "after\0bytes\n"); }],
  ["rename with staged content changes", (root) => { init(root, { "old.txt": "first\nsecond\nthird\n" }); renameSync(join(root, "old.txt"), join(root, "new.txt")); write(root, "new.txt", "first\nchanged\nthird\nextra\n"); git(root, "add", "-A"); }],
  ["file without final newline", (root) => { init(root, { "plain.txt": "before" }); write(root, "plain.txt", "before\nafter"); }],
  ["executable mode only", (root) => { init(root, { "run.sh": "#!/bin/sh\necho hi\n" }); if (process.platform !== "win32") chmodSync(join(root, "run.sh"), 0o755); }],
  ["staged deletion", (root) => { init(root, { "deleted.txt": "one\ntwo\nthree\n" }); rmSync(join(root, "deleted.txt")); git(root, "add", "deleted.txt"); }],
  ["staged addition then worktree edit", (root) => { init(root); write(root, "added.txt", "staged\n"); git(root, "add", "added.txt"); write(root, "added.txt", "worktree\nextra\n"); }],
];

for (const [name, setup, windowsSkip] of scenarios) {
  if (windowsSkip && process.platform === "win32") {
    test.skip(`${name}: ${windowsSkip}`, () => {});
    continue;
  }
  test(name, async () => {
    if (!gitStatus) return;
    const base = scratch();
    const root = join(base, "repo");
    try {
      await setup(root);
      await parity(root);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}

function putTreeFile(root: string, path: string, body = "fixture\n"): void {
  const file = join(root, path);
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, body);
}

const treeScenarios: Array<[string, (root: string) => void]> = [
  ["root ignore globs and negations", (root) => {
    putTreeFile(root, ".gitignore", "*.log\n!keep.log\n");
    putTreeFile(root, "drop.log"); putTreeFile(root, "keep.log");
  }],
  ["nested ignore rules", (root) => {
    putTreeFile(root, "src/.gitignore", "generated/\n!generated/keep.txt\n");
    putTreeFile(root, "src/generated/drop.txt"); putTreeFile(root, "src/generated/keep.txt");
  }],
  ["heavy directories", (root) => {
    putTreeFile(root, "node_modules/pkg/index.js"); putTreeFile(root, "target/debug/file"); putTreeFile(root, "src/main.ts");
  }],
  ["symbolic links", (root) => {
    putTreeFile(root, "target.txt");
    if (process.platform !== "win32") symlinkSync("target.txt", join(root, "link.txt"));
  }],
  ["spaces and accented names", (root) => {
    putTreeFile(root, "spazio nome.txt"); putTreeFile(root, "caffè.txt"); putTreeFile(root, "cafe\u0301.txt");
  }],
  ["default exclusions", (root) => {
    mkdirSync(join(root, ".git")); putTreeFile(root, ".git/config"); putTreeFile(root, ".DS_Store"); putTreeFile(root, "visible.txt");
  }],
  ["reserved secret directory", (root) => {
    putTreeFile(root, ".topics-secrets/key"); putTreeFile(root, "visible.txt");
  }],
  ["directory-only ignore", (root) => {
    putTreeFile(root, ".gitignore", "cache/\n"); putTreeFile(root, "cache/file.txt"); putTreeFile(root, "cache.txt");
  }],
  ["requested depth", (root) => {
    putTreeFile(root, "one/two/three/four.txt"); putTreeFile(root, "one/near.txt");
  }],
  ["protected media package", (root) => {
    putTreeFile(root, "Photos.photoslibrary/private/photo.jpg"); putTreeFile(root, "visible.txt");
  }],
  ["hidden files remain visible", (root) => {
    putTreeFile(root, ".env.local"); putTreeFile(root, ".well-known/config");
  }],
];

test.skipIf(!nativeWalkFileTree)("native file tree matches JavaScript on ten fixture trees and this checkout", async () => {
  for (const [name, setup] of treeScenarios) {
    const base = scratch();
    const root = join(base, "tree");
    try {
      mkdirSync(root, { recursive: true });
      setup(root);
      const expected = await walkFileTreeJs(root, 4);
      const actual = await nativeWalkFileTree!(root, 4);
      expect(actual, name).toEqual(expected);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  const root = resolve(import.meta.dir, "..");
  expect(await nativeWalkFileTree!(root, 3)).toEqual(await walkFileTreeJs(root, 3));

  if (process.platform === "win32") {
    console.log("SKIP unreadable-folder parity: chmod 000 does not enforce access on Windows");
    return;
  }
  if (process.getuid?.() === 0) {
    console.log("SKIP unreadable-folder parity: tests run as root, chmod 000 is ineffective");
    return;
  }

  const base = scratch();
  const unreadableRoot = join(base, "tree");
  const locked = join(unreadableRoot, "locked");
  try {
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, "hidden.txt"), "x");
    writeFileSync(join(unreadableRoot, "visible.txt"), "x");
    chmodSync(locked, 0o000);
    const expected = await walkFileTreeJs(unreadableRoot, 3);
    const actual = await nativeWalkFileTree!(unreadableRoot, 3);
    expect(actual).toEqual(expected);
    expect(actual.find(({ name }) => name === "locked")?.children).toEqual([]);
  } finally {
    try { chmodSync(locked, 0o755); } catch {}
    rmSync(base, { recursive: true, force: true });
  }
});

test.skipIf(!nativeWalkFileTree)("native file tree keeps a missing root as an error", async () => {
  const base = scratch();
  try {
    await expect(nativeWalkFileTree!(join(base, "missing"), 3)).rejects.toThrow();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
