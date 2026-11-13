/**
 * The backup-residue gate: green on a clean tree, red with a `x.md-e` added.
 *
 * @covers RUNTIME-22
 */
import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findResidues } from "./check-backup-residue";

const SCRIPT = join(import.meta.dir, "check-backup-residue.ts");

describe("check-backup-residue", () => {
  test("flags the four residue suffixes and nothing else", () => {
    expect(findResidues(["a.md-e", "b.orig", "c.rej", "d.bak"])).toHaveLength(4);
    expect(findResidues(["a.md", "src/x.ts", "e", "my-env"])).toEqual([]);
  });

  test("green on a clean repo, red naming the file when x.md-e is added", async () => {
    const dir = mkdtempSync(join(tmpdir(), "residue-"));
    await $`git init -q -b main && git config user.email t@t.t && git config user.name t`.cwd(dir).quiet();
    await Bun.write(join(dir, "a.md"), "one\n");
    await $`git add -A && git commit -qm base`.cwd(dir).quiet();
    const clean = await $`bun ${SCRIPT}`.cwd(dir).quiet().nothrow();
    expect(clean.exitCode).toBe(0);

    await Bun.write(join(dir, "x.md-e"), "copy\n");
    const dirty = await $`bun ${SCRIPT}`.cwd(dir).quiet().nothrow();
    expect(dirty.exitCode).toBe(1);
    expect(dirty.stderr.toString()).toContain("x.md-e");
  });
});
