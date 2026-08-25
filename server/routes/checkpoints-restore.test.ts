/**
 * Stepping back one turn must not leave the repository in DETACHED HEAD.
 *
 * THE DEFECT, in the feature that already ships. The checkpoint rollback ran
 * `git checkout <hash>`, which moves HEAD onto the commit. The files come back,
 * so it looks like it worked - and the repository is now on no branch at all.
 * The next commit the user makes lands nowhere, `git status` opens with a
 * paragraph of warning instead of their work, and nothing in the response said
 * so: it reported `rolled: true` and stopped.
 *
 * That is a bad trade for the gesture being asked for. "Undo the last turn" is
 * a small, reversible request; detached HEAD is neither small nor obvious to
 * get out of for someone who did not ask to be there.
 *
 * `git restore --source=<hash> -- .` puts the files back and leaves HEAD where
 * it was. These tests run against a REAL repository because the whole claim is
 * about git's own state, and a fake would just be me asserting my own belief
 * about what git does.
 *
 * @covers CHAT-05
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let repo: string;
const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "topics-ckpt-"));
  git("init", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "f.txt"), "prima\n");
  git("add", "-A");
  git("commit", "-m", "uno");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("il ripristino di un checkpoint", () => {
  test("riporta il contenuto del file", () => {
    const primo = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "f.txt"), "dopo\n");
    git("add", "-A");
    git("commit", "-m", "due");

    git("restore", "--source", primo, "--", ".");
    expect(readFileSync(join(repo, "f.txt"), "utf8")).toBe("prima\n");
  });

  test("e lascia HEAD su un ramo", () => {
    // The whole point. `symbolic-ref` fails on a detached HEAD, so this is the
    // assertion that would have caught the shipped defect.
    const primo = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "f.txt"), "dopo\n");
    git("add", "-A");
    git("commit", "-m", "due");

    git("restore", "--source", primo, "--", ".");
    expect(git("symbolic-ref", "HEAD")).toBe("refs/heads/main");
  });

  test("`checkout <hash>` invece STACCA la testa: e' il difetto, misurato", () => {
    // Non-vacuity for the two tests above: they only mean something if the old
    // command really did what the docblock says. Asserted rather than trusted.
    const primo = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "f.txt"), "dopo\n");
    git("add", "-A");
    git("commit", "-m", "due");

    git("checkout", primo);
    expect(() => git("symbolic-ref", "HEAD"), "se questo NON fallisce, il difetto non esisteva").toThrow();
  });

  test("il codice del ripristino non usa piu' `checkout`", () => {
    // The tests above prove what git does; this one proves the route uses it.
    // Without it, the two could stay green while the shipped path went back to
    // `checkout` - which is exactly how this defect survived until now.
    const src = readFileSync(join(import.meta.dir, "checkpoints.ts"), "utf8");
    expect(src).toContain('"restore", "--source"');
    expect(src, "il ripristino e' tornato a staccare la testa").not.toMatch(/runGit\(\["checkout"/);
  });
});
