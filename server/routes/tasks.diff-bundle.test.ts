/**
 * @covers KANBAN-49
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, renameSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitDiffBundle } from "./tasks";
import { gitDiffStat } from "../lib/git-diff-stat";
import { splitPatch } from "../../client/src/components/Board/diffFileRows";

// gitDiffBundle drives a real `git` — these tests build a throwaway repo per case
// and assert the untracked-inclusion contract that keeps new-file-only deliveries
// from rendering as an empty review diff (the bug this fix closes).

async function git(cwd: string, args: string[]): Promise<void> {
  const p = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  await p.exited;
}

describe("gitDiffBundle untracked inclusion", () => {
  let dir: string;
  let base: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "diffbundle-"));
    await git(dir, ["init", "-q"]);
    await git(dir, ["config", "user.email", "t@t.t"]);
    await git(dir, ["config", "user.name", "t"]);
    await git(dir, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(dir, "tracked.txt"), "base\n");
    await git(dir, ["add", "tracked.txt"]);
    await git(dir, ["commit", "-qm", "base"]);
    base = (await (async () => {
      const p = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: dir, stdout: "pipe" });
      return (await new Response(p.stdout).text()).trim();
    })());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a new-file-only worktree is EMPTY without includeUntracked, and shown WITH it", async () => {
    writeFileSync(join(dir, "delivery.md"), "line1\nline2\n");

    const without = await gitDiffBundle(dir, base);
    expect(without.stat).toHaveLength(0);
    expect(without.patch).toBe("");

    const withUntracked = await gitDiffBundle(dir, base, { includeUntracked: true });
    const entry = withUntracked.stat.find((s) => s.path === "delivery.md");
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("A");
    expect(entry!.additions).toBe(2);
    expect(entry!.deletions).toBe(0);
    expect(withUntracked.patch).toContain("new file mode");
    expect(withUntracked.patch).toContain("+line1");
    expect(withUntracked.patch).toContain("+line2");
  });

  test("tracked edits and untracked files coexist in one bundle", async () => {
    writeFileSync(join(dir, "tracked.txt"), "base\nmore\n");
    writeFileSync(join(dir, "brand-new.txt"), "hi\n");

    const bundle = await gitDiffBundle(dir, base, { includeUntracked: true });
    const tracked = bundle.stat.find((s) => s.path === "tracked.txt");
    const untracked = bundle.stat.find((s) => s.path === "brand-new.txt");
    expect(tracked).toBeDefined();
    expect(tracked!.additions).toBe(1);
    expect(untracked).toBeDefined();
    expect(untracked!.status).toBe("A");
  });

  test("gitignored files stay out (respects --exclude-standard)", async () => {
    writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
    await git(dir, ["add", ".gitignore"]);
    await git(dir, ["commit", "-qm", "ignore"]);
    const base2 = (await (async () => {
      const p = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: dir, stdout: "pipe" });
      return (await new Response(p.stdout).text()).trim();
    })());
    writeFileSync(join(dir, "ignored.txt"), "secret\n");
    writeFileSync(join(dir, "wanted.txt"), "ok\n");

    const bundle = await gitDiffBundle(dir, base2, { includeUntracked: true });
    expect(bundle.stat.some((s) => s.path === "ignored.txt")).toBe(false);
    expect(bundle.stat.some((s) => s.path === "wanted.txt")).toBe(true);
  });

  test("an untracked file is counted the way `git diff --no-index --numstat` counts it", async () => {
    // The count is taken without a git spawn per file: it must still be git's.
    writeFileSync(join(dir, "text.txt"), "a\nb\n");
    writeFileSync(join(dir, "no-newline.txt"), "a\nb");
    writeFileSync(join(dir, "crlf.txt"), "a\r\nb\r\n");
    writeFileSync(join(dir, "empty.txt"), "");
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0x61, 0x00, 0x62, 0x0a]));
    symlinkSync("text.txt", join(dir, "link"));
    const names = ["blob.bin", "crlf.txt", "empty.txt", "link", "no-newline.txt", "text.txt"];
    const byGit = async (f: string): Promise<[number, number]> => {
      const p = Bun.spawn(["git", "diff", "--no-index", "--numstat", "--", "/dev/null", f], { cwd: dir, stdout: "pipe" });
      const [a, d] = (await new Response(p.stdout).text()).split("\t");
      return [a === "-" ? -1 : Number(a), d === "-" ? -1 : Number(d)];
    };

    const { stat } = await gitDiffStat(dir, base, { includeUntracked: true });
    const counted = Object.fromEntries(stat.map((s) => [s.path, [s.additions, s.deletions]]));
    expect(Object.keys(counted).sort()).toEqual(names);
    for (const f of names) expect([f, ...counted[f]!]).toEqual([f, ...(await byGit(f))]);
  });

  test("an untracked file .gitattributes marks `-diff`, `binary` or `diff` is counted the way git counts it", async () => {
    // `-diff` and `binary` turn a text file into «Binary files differ» in the
    // patch of the same bundle; `diff` forces text on a file with a NUL.
    writeFileSync(join(dir, ".gitattributes"), "*.lock -diff\n*.dat binary\n*.txt diff\n");
    await git(dir, ["add", ".gitattributes"]);
    await git(dir, ["commit", "-qm", "attributes"]);
    writeFileSync(join(dir, "x.lock"), "a\nb\nc\n");
    writeFileSync(join(dir, "y.dat"), "a\nb\n");
    writeFileSync(join(dir, "z.txt"), Buffer.from([0x61, 0x00, 0x62, 0x0a]));
    writeFileSync(join(dir, "w.md"), "q\n");
    const names = ["w.md", "x.lock", "y.dat", "z.txt"];
    const byGit = async (f: string): Promise<[number, number]> => {
      const p = Bun.spawn(["git", "diff", "--no-index", "--numstat", "--", "/dev/null", f], { cwd: dir, stdout: "pipe" });
      const [a, d] = (await new Response(p.stdout).text()).split("\t");
      return [a === "-" ? -1 : Number(a), d === "-" ? -1 : Number(d)];
    };

    const { stat } = await gitDiffStat(dir, "HEAD", { includeUntracked: true });
    const counted = Object.fromEntries(stat.map((s) => [s.path, [s.additions, s.deletions]]));
    expect(Object.keys(counted).sort()).toEqual(names);
    for (const f of names) expect([f, ...counted[f]!]).toEqual([f, ...(await byGit(f))]);
  });

  test("paths with spaces survive (-z NUL split)", async () => {
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "domande di chiarimento.md"), "q\n");
    const bundle = await gitDiffBundle(dir, base, { includeUntracked: true });
    expect(bundle.stat.some((s) => s.path === "docs/domande di chiarimento.md")).toBe(true);
  });

  test("a path with non-ASCII letters is the file's own name, not git's quoted octal", async () => {
    // Without -z git prints `"docs/citt\303\240.md"`: the chat's strip then
    // listed the same file twice, once from the tool call and once from here.
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "città.md"), "a\nb\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-qm", "accented"]);

    const { stat } = await gitDiffStat(dir, `${base}..HEAD`);
    expect(stat).toEqual([{ path: "docs/città.md", additions: 2, deletions: 0, status: "A" }]);
  });

  test("a non-ASCII path heads its own patch chunk, committed or untracked, so the drawer finds its lines", async () => {
    // A quoted `diff --git "a/docs/citt\303\240.md" …` header is no chunk to the
    // drawer's splitter: the file opened with no patch, and its lines went into
    // the chunk of the file before it.
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "città.md"), "a\nb\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-qm", "accented"]);
    writeFileSync(join(dir, "perché.txt"), "nuovo\n");

    const bundle = await gitDiffBundle(dir, base, { includeUntracked: true });
    expect(splitPatch(bundle.patch).map((c) => c.path).sort()).toEqual(["docs/città.md", "perché.txt"]);
  });

  // Su un rinominato `--numstat` non stampa un path ma la TRASFORMAZIONE: presa
  // alla lettera non combacia con il `b/…` del patch, e da quando l'elenco dei
  // file si costruisce dallo stat quel disallineamento elencherebbe lo stesso
  // file due volte (una per lo stat, una per il pezzo di patch).
  test("un file RINOMINATO ha lo stesso path nello stat e nel patch", async () => {
    mkdirSync(join(dir, "vecchia"));
    writeFileSync(join(dir, "vecchia", "modulo.ts"), "export const x = 1;\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-qm", "modulo"]);
    const from = (await (async () => {
      const p = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: dir, stdout: "pipe" });
      return (await new Response(p.stdout).text()).trim();
    })());
    mkdirSync(join(dir, "nuova"));
    renameSync(join(dir, "vecchia", "modulo.ts"), join(dir, "nuova", "modulo.ts"));
    await git(dir, ["add", "-A"]);

    const bundle = await gitDiffBundle(dir, from);
    expect(bundle.stat.map((s) => s.path)).toEqual(["nuova/modulo.ts"]);
    expect(bundle.stat[0]!.status).toBe("R");
    expect(bundle.patch).toContain("b/nuova/modulo.ts");
  });
});
