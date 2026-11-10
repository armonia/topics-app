import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pushMainToOrigin, sweepUnpushedMains } from "./main-on-origin";

const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync("git", ["-C", cwd, ...a], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
function setup() {
  const root = mkdtempSync(join(tmpdir(), "mop-"));
  const origin = join(root, "origin.git"); const work = join(root, "work");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  spawnSync("git", ["clone", "-q", origin, work]);
  for (const [k, v] of [["user.email", "t@t"], ["user.name", "t"], ["commit.gpgsign", "false"], ["core.hooksPath", "/dev/null"]]) git(work, "config", k, v);
  git(work, "checkout", "-q", "-b", "main");
  writeFileSync(join(work, "a"), "1"); git(work, "add", "a"); git(work, "commit", "-qm", "one");
  git(work, "push", "-q", "origin", "main");
  return { root, origin, work };
}
const commit = (cwd: string, f: string) => { writeFileSync(join(cwd, f), f); git(cwd, "add", f); git(cwd, "commit", "-qm", f); };

describe("main su origin, solo fast-forward", () => {
  test("land locale avanti → push", async () => {
    const { root, origin, work } = setup();
    try {
      commit(work, "b"); commit(work, "c");
      const r = await pushMainToOrigin(work);
      expect(r).toEqual({ ok: true, pushed: 2 });
      expect(git(origin, "rev-parse", "main")).toBe(git(work, "rev-parse", "main"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("storie divergenti → niente push, mai forzato", async () => {
    const { root, origin, work } = setup();
    try {
      const other = join(root, "other");
      spawnSync("git", ["clone", "-q", origin, other]);
      for (const [k, v] of [["user.email", "t@t"], ["user.name", "t"], ["commit.gpgsign", "false"], ["core.hooksPath", "/dev/null"]]) git(other, "config", k, v);
      commit(other, "x"); git(other, "push", "-q", "origin", "main");
      const before = git(origin, "rev-parse", "main");
      commit(work, "y");
      const r = await pushMainToOrigin(work);
      expect(r.ok).toBe(false);
      expect(git(origin, "rev-parse", "main")).toBe(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("la spazzata riporta su origin e lo segnala", async () => {
    const { root, origin, work } = setup();
    try {
      commit(work, "z");
      const seen: Array<[string, number]> = [];
      await sweepUnpushedMains([work], (repo, n) => seen.push([repo, n]));
      expect(seen).toEqual([[work, 1]]);
      expect(git(origin, "rev-parse", "main")).toBe(git(work, "rev-parse", "main"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
