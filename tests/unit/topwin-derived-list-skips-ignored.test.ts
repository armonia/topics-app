/**
 * `tools/topwin sync` on a PC copy with no list of shipped files never deletes
 * a file the repo now ignores.
 *
 * Without `.topwin-shipped` the script guesses what it shipped from the
 * history: every path some commit deleted. Among them are files git tracked
 * once and IGNORES now (515 of ~2400 on 03/10: docs/DEAD-CODE.md,
 * videos/INDEX.md, bench/results/...), which on the PC are what runs there
 * generate, not what a sync shipped.
 *
 * Driven end to end with no PC: a throwaway repo with that history, the real
 * script copied into it, and a fake `ssh` on PATH that plays the PC on a local
 * folder (the cmd forms the script sends: the manifest read, the existence
 * probe, the removal, the archive) and writes down every path it was asked to
 * remove.
 * @covers GATE-18
 */
import { afterAll, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const work = mkdtempSync(join(tmpdir(), "topwin-ignored-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const ENV = {
  ...(process.env as Record<string, string>),
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: ENV });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

function put(root: string, path: string, text = path): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** The PC, on a folder: answers the cmd lines `tools/topwin sync` sends, and logs each removal. */
const FAKE_SSH = String.raw`#!/bin/bash
while [ $# -gt 0 ]; do case "$1" in -n) shift ;; -o) shift 2 ;; *) break ;; esac; done
shift
cmd="$*"
# The quoted Windows paths of the line, with forward slashes.
paths() { printf '%s\n' "$cmd" | grep -o '"[^"%]*"' | tr -d '"' | tr '\\' '/'; }
case "$cmd" in
  *"tar -xf -"*) cat > /dev/null ;;
  *"type .topwin-shipped"*) if [ -f "$FAKE_PC/.topwin-shipped" ]; then cat "$FAKE_PC/.topwin-shipped"; else exit 3; fi ;;
  *"do @if exist"*) paths | while IFS= read -r p; do [ -f "$FAKE_PC/$p" ] && printf '%s\r\n' "$p" | tr '/' '\\'; done; exit 0 ;;
  *"del /f /q"*) paths >> "$FAKE_LOG" ;;
esac
exit 0
`;

const IGNORED_NOW = ["docs/DEAD-CODE.md", "videos/INDEX.md", "bench/results/turn-time-latest.json"];

test("a path git once tracked and now ignores is never deleted from the PC, a plain deleted one is", () => {
  const repo = join(work, "repo");
  const pc = join(work, "pc");
  const bin = join(work, "bin");
  const log = join(work, "del.log");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  put(repo, "keep.txt");
  put(repo, "gone.txt");
  put(repo, "src/old.ts");
  for (const p of IGNORED_NOW) put(repo, p);
  mkdirSync(join(repo, "tools"), { recursive: true });
  copyFileSync(join(ROOT, "tools", "topwin"), join(repo, "tools", "topwin"));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "one");
  git(repo, "rm", "-q", "gone.txt", "src/old.ts", ...IGNORED_NOW);
  // The repo's own rules, in the shapes it uses: a file, a folder, a glob with an exception.
  put(repo, ".gitignore", "docs/DEAD-CODE.md\nbench/results/\nvideos/*\n!videos/README.md\n");
  git(repo, "add", ".gitignore");
  git(repo, "commit", "-q", "-m", "two");

  // The PC as an older sync left it, plus what runs there generated since.
  for (const p of ["keep.txt", "gone.txt", "src/old.ts", ...IGNORED_NOW]) put(pc, p);
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "ssh"), FAKE_SSH);
  chmodSync(join(bin, "ssh"), 0o755);

  const r = Bun.spawnSync(["bash", join(repo, "tools", "topwin"), "sync"], {
    cwd: repo,
    env: { ...ENV, PATH: `${bin}:${process.env.PATH}`, WINFLEET_SSH: "fake-pc", FAKE_PC: pc, FAKE_LOG: log },
  });
  expect({ exit: r.exitCode, stderr: r.stderr.toString() }).toEqual({ exit: 0, stderr: "" });
  const deleted = existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n").filter(Boolean).sort() : [];
  expect(deleted).toEqual(["gone.txt", "src/old.ts"]);
  expect(r.stdout.toString()).toContain("3 of them are ignored by the repo now");
});
