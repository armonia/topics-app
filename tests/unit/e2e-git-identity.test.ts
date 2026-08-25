/**
 * @covers E2E-GATE-08
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const E2E = join(import.meta.dir, "..", "e2e");

/**
 * A spec that shells out to `git` must carry its own identity.
 *
 * `git commit` needs a `user.name` and a `user.email`. On a development laptop
 * the global config supplies them and nobody notices; on a CI runner there is no
 * global config, so the commit dies with "Please tell me who you are" and the
 * spec fails talking about a locator instead of about git.
 *
 * This repo has now paid for that three times. `helpers/file-project.ts`
 * documents the first: the nightly suite was red three nights running, and the
 * fix was `initGitRepo`, which passes the identity with `-c`. Its own docstring
 * says the helper exists because the code "was copied into three fixtures and
 * only one had the identity". On 2026-08-15 the copies were up to five, and the
 * PR gate had just become blocking, so they took main down with them.
 *
 * The lesson is not "remember the flags". It is that the flags belong to every
 * git invocation in a spec, and a reader cannot be the thing that enforces it.
 * Hence this test, which is cheap and runs in `bun run test:unit`, long before
 * anyone waits for a browser.
 *
 * Why `-c` and not `git config user.email` after `git init`: `-c` cannot be
 * forgotten on the ONE call that matters, it leaves no state behind in a temp
 * repo somebody may reuse, and it works the same whether or not the directory is
 * a repo yet.
 */

/** Verbs that write a commit, i.e. the ones that need an author. */
const NEEDS_AUTHOR = ["commit", "cherry-pick", "revert", "merge", "rebase", "am", "stash"];

interface Offence {
  file: string;
  line: number;
  text: string;
}

function specFiles(): string[] {
  return readdirSync(E2E, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && (d.name.endsWith(".spec.ts") || d.name.endsWith(".ts")))
    .map((d) => join(d.parentPath ?? E2E, d.name));
}

/**
 * Does this call have an identity, wherever it keeps it.
 *
 * Three shapes are legitimate and all three appear in this suite:
 *   git("-c", "user.email=...", ...)                 inline
 *   git([...IDENTITA, ...args])                      spread from a file constant
 *   const git = (...a) => execFileSync("git", ["-c", "user.email=...", ...a])   a helper
 * The second one is the nicest and the naive check called it a defect, so the
 * rule follows the identity instead of the spelling: a spread whose constant is
 * declared IN THIS FILE with the identity in it counts.
 */
function identityInScope(window: string, src: string): boolean {
  if (window.includes("user.email") && window.includes("user.name")) return true;
  for (const m of window.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/g)) {
    const name = m[1]!;
    if (name === "args") continue; // the helper's own parameter, judged on its own line
    const decl = new RegExp(`(?:const|let|var)\\s+${name}\\b[^;]*`, "s").exec(src)?.[0] ?? "";
    if (decl.includes("user.email") && decl.includes("user.name")) return true;
  }
  return false;
}

/**
 * A git invocation is judged on the ARGUMENT LIST it is given, on the same line
 * or on the two that follow, because that is where `-c` would be and prettier
 * wraps long calls.
 */
function offences(): Offence[] {
  const found: Offence[] = [];
  for (const file of specFiles()) {
    const src = readFileSync(file, "utf8");
    if (!src.includes('"git"')) continue;
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      if (!line.includes('"git"')) return;
      // The call's arguments can spill over a couple of lines when prettier wraps.
      const window = lines.slice(i, i + 3).join(" ");
      const writes = NEEDS_AUTHOR.some((verb) => window.includes(`"${verb}"`));
      // A helper that forwards `...args` is the identity-carrying shape: judge it
      // on whether IT has the flags, not on what its callers pass.
      const forwards = window.includes("...args");
      if (!writes && !forwards) return;
      if (identityInScope(window, src)) return;
      // A forwarding helper with no write verb of its own is only a problem when
      // it has no identity; a non-forwarding call is only a problem when it
      // writes. Both land here.
      found.push({ file: file.slice(file.indexOf("tests/")), line: i + 1, text: line.trim().slice(0, 120) });
    });
  }
  return found;
}

describe("every git invocation in an e2e spec carries its own identity", () => {
  test("no spec commits with the machine's git config", () => {
    const bad = offences();
    expect(
      bad.map((o) => `${o.file}:${o.line}  ${o.text}`),
      "these die with 'Please tell me who you are' on any machine without a global git config, i.e. on CI and never on yours. " +
        "Pass it inline: git('-c', 'user.email=e2e@test', '-c', 'user.name=e2e', '-c', 'commit.gpgsign=false', ...)",
    ).toEqual([]);
  });

  test("the detector is not vacuous: it sees a bare commit and forgives an identified one", () => {
    // Guarding the guard. If `offences()` ever stops matching, this fails and the
    // green above stops meaning anything.
    const bare = 'execFileSync("git", ["commit", "-q", "-m", "init"], { cwd });';
    const dressed = 'execFileSync("git", ["-c", "user.email=e2e@test", "-c", "user.name=e2e", "commit", "-m", "x"], { cwd });';
    const spread = 'execFileSync("git", [...IDENTITA, ...args], { cwd });';
    const declaresIt = 'const IDENTITA = ["-c", "user.email=e2e@test", "-c", "user.name=e2e"];';
    const writes = (s: string) => NEEDS_AUTHOR.some((v) => s.includes(`"${v}"`));
    expect(writes(bare) && !identityInScope(bare, bare)).toBe(true);
    expect(identityInScope(dressed, dressed)).toBe(true);
    // The shape that produced a false positive on the first run of this test.
    expect(identityInScope(spread, declaresIt + "\n" + spread)).toBe(true);
    expect(identityInScope(spread, spread)).toBe(false);
  });

  test("the shared helper is still the one to copy", () => {
    // Named on purpose: when this test fails, the fix is to use this, not to
    // paste four flags for the sixth time.
    const helper = readFileSync(join(E2E, "helpers", "file-project.ts"), "utf8");
    expect(helper).toContain("export function initGitRepo");
    expect(helper).toContain("user.email");
    expect(helper).toContain("commit.gpgsign=false");
  });
});
