/**
 * @covers KANBAN-49
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitDiffBundle, numstatPath } from "./tasks";

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

  test("paths with spaces survive (-z NUL split)", async () => {
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "domande di chiarimento.md"), "q\n");
    const bundle = await gitDiffBundle(dir, base, { includeUntracked: true });
    expect(bundle.stat.some((s) => s.path === "docs/domande di chiarimento.md")).toBe(true);
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
    expect(bundle.patch).toContain("b/nuova/modulo.ts");
  });
});

describe("numstatPath", () => {
  test("un path normale passa intatto", () => {
    expect(numstatPath("server/routes/tasks.ts")).toBe("server/routes/tasks.ts");
    expect(numstatPath("  spazi/attorno.ts  ")).toBe("spazi/attorno.ts");
  });

  test("la forma con la freccia dà il path di DESTINAZIONE", () => {
    expect(numstatPath("vecchio.ts => nuovo.ts")).toBe("nuovo.ts");
    expect(numstatPath("a/b/vecchio.ts => c/d/nuovo.ts")).toBe("c/d/nuovo.ts");
  });

  test("la forma con le graffe si risolve DENTRO il path", () => {
    expect(numstatPath("server/{vecchia => nuova}/modulo.ts")).toBe("server/nuova/modulo.ts");
    expect(numstatPath("{ => sotto}/f.ts")).toBe("sotto/f.ts");
    // Il segmento sparisce del tutto: niente doppia barra nel risultato.
    expect(numstatPath("server/{vecchia => }/modulo.ts")).toBe("server/modulo.ts");
  });

  test("una freccia che fa parte del NOME non viene scambiata per un rename", () => {
    expect(numstatPath("docs/a=>b.md")).toBe("docs/a=>b.md");
  });
});
