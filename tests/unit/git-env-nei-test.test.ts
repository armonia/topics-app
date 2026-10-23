/**
 * Whoever launches `git` in a test carries the preload's isolated environment.
 *
 * WHY HAVING FIXED THEM IS NOT ENOUGH. On 24/08 seventeen test files were
 * building a real git repo and making 46 commits in it, inheriting the
 * machine's config, hooks included. On the development one `core.hooksPath`
 * points at a third-party `prepare-commit-msg` that on every commit fires two
 * `curl --max-time 2` at `localhost:3333`: measured, 380ms per commit against
 * 160ms, and under load the tests overran the timeout. The symptom was the
 * worst one available, a red that showed up ONLY in the whole suite and on a
 * different test every time.
 *
 * WHAT IS LEFT FOR THIS GATE TO DO, since 22/10/2026. The isolation is now in
 * the environment `bun test` is BORN with: `scripts/test-unit-shards.ts`
 * builds it in `fileEnv()`, which wraps the base in `gitIsolationEnv`, and a
 * variable that is there at birth is inherited by every git child for free
 * (measured in `tests/unit/git-isolation-inherited.test.ts`). So on the whole
 * suite, in CI included, a forgotten `env` no longer lets the hooks in.
 *
 * It still does on `bun test <file>` typed by hand, which is how a red gets
 * triaged and the one path with no wrapper in front of it: there only the
 * preload runs, it writes the variables at RUNTIME, and Bun does not pass
 * those to a child. That path is this gate's whole remaining job, and it is
 * the one a developer uses while writing the test that would be slow.
 *
 * WHAT IT DEMANDS, and why so little: that where there is a `git` spawn there
 * is also an `env`, not that it be `gitEnv()`. `landing-verdict.test.ts`
 * passes `process.env` with `GIT_AUTHOR_DATE` inside it to pin the dates, and
 * inherits the isolation all the same, so demanding the function's name would
 * fail it for nothing. The difference that counts is between «I pass an
 * environment» and «I pass none at all».
 *
 * It does not ask whether the command can fire a hook. `commit` can and
 * `rev-parse` cannot, but a sixth of these calls build their argument list at
 * runtime (`execFileSync("git", args)`), so a scanner that judged the
 * subcommand would be blind exactly on the helpers that then commit. One
 * argument per call costs less than that blind spot.
 *
 * @covers GATE-09
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gitEnv } from "../setup/bun-test-preload";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** The test files git tracks: the untracked ones belong to nobody. */
function trackedTestFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "*.test.ts"], {
    env: gitEnv(),
    cwd: REPO_ROOT,
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
  });
  // This file is NOT excluded any more, and that is the point of the mask
  // below. The proof «the scanner can say NO» needs a literal example of the
  // bad form, and until 22/10/2026 that example made the gate report itself,
  // so the gate had to skip its own file. Now the example sits inside a
  // string, the mask sees that it is not a call, and the gate covers itself
  // like any other file.
  return out.split("\n").filter(Boolean);
}

/** The characters a `/` may follow and still open a regex literal, as words. */
const KEYWORDS_BEFORE_REGEX = ["return", "typeof", "case", "in", "of", "new", "delete", "void", "await", "yield"];

/**
 * For every character: 1 if it is inside a string, a comment or a regex
 * literal, 0 if it is code.
 *
 * It exists because a `git` spawn written down as TEXT is not a call. Three
 * files here keep one as a fixture to prove their own scanner is not vacuous,
 * and `e2e-git-identity.test.ts` has one in a doc comment showing the shape to
 * use. Counting those as offences made the gate ask to be disarmed in order to
 * go green, which is a defect in its perimeter and not in its rule.
 *
 * Regex literals are tracked for the opposite reason, and it is the dangerous
 * one: a regex such as `/["']git["']/` carries an odd number of quotes, and
 * mistaking it for the start of a string would mask the REAL code after it and
 * hide an offence.
 */
function nonCodeMask(t: string): Uint8Array {
  const m = new Uint8Array(t.length);
  type State = "code" | "line" | "block" | "single" | "double" | "template" | "regex";
  let state: State = "code";
  let i = 0;
  /** The last code character before `i`, which decides `/` regex vs division. */
  let lastCode = "";
  let lastCodeAt = -1;
  while (i < t.length) {
    const c = t[i]!;
    const n = t[i + 1] ?? "";
    if (state === "code") {
      if (c === "/" && n === "/") { state = "line"; m[i] = 1; m[i + 1] = 1; i += 2; continue; }
      if (c === "/" && n === "*") { state = "block"; m[i] = 1; m[i + 1] = 1; i += 2; continue; }
      if (c === "/" && openRegex(t, lastCode, lastCodeAt)) { state = "regex"; m[i] = 1; i += 1; continue; }
      if (c === "'") { state = "single"; m[i] = 1; i += 1; continue; }
      if (c === '"') { state = "double"; m[i] = 1; i += 1; continue; }
      if (c === "`") { state = "template"; m[i] = 1; i += 1; continue; }
      if (!/\s/.test(c)) { lastCode = c; lastCodeAt = i; }
      i += 1;
      continue;
    }
    m[i] = 1;
    if (state === "line") {
      if (c === "\n") { m[i] = 0; state = "code"; }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && n === "/") { m[i + 1] = 1; state = "code"; i += 2; continue; }
      i += 1;
      continue;
    }
    // string or regex: a backslash hides whatever follows it
    if (c === "\\") { if (i + 1 < t.length) m[i + 1] = 1; i += 2; continue; }
    if (state === "single" && c === "'") state = "code";
    else if (state === "double" && c === '"') state = "code";
    else if (state === "template" && c === "`") state = "code";
    else if (state === "regex" && (c === "/" || c === "\n")) state = "code";
    i += 1;
  }
  return m;
}

/** A `/` opens a regex unless what comes before it could end an expression. */
function openRegex(t: string, lastCode: string, lastCodeAt: number): boolean {
  if (lastCode === "") return true; // start of file
  if (/[)\]}]/.test(lastCode)) return false;
  if (!/[\w$]/.test(lastCode)) return true; // an operator, a comma, a brace
  // An identifier: division, unless the identifier is a keyword.
  const word = /[\w$]+$/.exec(t.slice(Math.max(0, lastCodeAt - 20), lastCodeAt + 1))?.[0] ?? "";
  return KEYWORDS_BEFORE_REGEX.includes(word);
}

/**
 * The `git` spawns in a file that pass no `env`.
 *
 * Every form that starts a process is looked for, not just the one in use at
 * the time: on 22/10/2026 CI went red on a `Bun.spawnSync(["git", ...])` with
 * no options, and the scanner of the day did not know `execFileSync("git")` at
 * all, which is the form of two thirds of these calls. A gate that a different
 * function name walks past is not a gate.
 *
 * The call is looked at in full up to the parenthesis that closes it, because
 * `env` lives in the options and those can wrap onto the next line. An `env`
 * that appears AFTER the end of the call is not this call's.
 */
function spawnsWithoutEnv(text: string): number {
  const mask = nonCodeMask(text);
  const re =
    /(?:Bun\.)?(?:spawnSync|spawn|execFileSync|execFile|execSync|exec)\(\s*(?:\[\s*)?["']git(?:["']|\s)/g;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (mask[m.index]) continue; // text, not a call
    // `re.exec("git...")` and any other method: the collision is with `exec`,
    // which is also a method of RegExp. `Bun.spawnSync` is the one dotted name
    // that is legitimate.
    const prev = text[m.index - 1];
    if (prev === "." && !m[0].startsWith("Bun.")) continue;
    // From the call, take up to the closing brace of the options or to the
    // final parenthesis: that is where `env` lives.
    const tail = text.slice(m.index, m.index + 900);
    const end = tail.indexOf(");");
    const call = end === -1 ? tail : tail.slice(0, end);
    // `env: something`, or the shorthand form `{ ..., env }`, which
    // `landing-verdict.test.ts` uses to slip GIT_AUTHOR_DATE in: it passes an
    // environment to all intents and purposes, and failing it would be a false
    // positive.
    if (!/\benv\s*[:,}]/.test(call)) count += 1;
  }
  return count;
}

describe("i test che lanciano git si portano l'ambiente isolato", () => {
  test("lo scanner vede qualcosa (guardia contro un elenco vuoto)", () => {
    // Without this line the test would be green even if `git ls-files`
    // returned nothing, i.e. while measuring nothing.
    const files = trackedTestFiles();
    expect(files.length).toBeGreaterThan(100);
  });

  test("lo scanner sa dire di NO (guardia contro un controllo che non morde)", () => {
    // The negative case: if `spawnsWithoutEnv` stopped recognising the form,
    // the test below would pass forever without looking at anything.
    expect(spawnsWithoutEnv(`Bun.spawnSync(["git", "-C", d, "log"], { stdout: "pipe" });`)).toBe(1);
    expect(spawnsWithoutEnv(`Bun.spawnSync(["git", "-C", d, "log"], { stdout: "pipe", env: gitEnv() });`)).toBe(0);
    expect(spawnsWithoutEnv(`Bun.spawnSync(["git", "log"], { env: process.env });`)).toBe(0);
    expect(spawnsWithoutEnv(`Bun.spawnSync(["git", "log"], { stdout: "pipe", env });`)).toBe(0);
  });

  test("ogni forma che avvia un processo conta, non solo quella di ieri", () => {
    // The hole that made CI red: the scanner knew `Bun.spawnSync` and did not
    // know the form two thirds of this repo's tests actually use.
    expect(spawnsWithoutEnv(`execFileSync("git", args, { cwd: dir, encoding: "utf8" });`)).toBe(1);
    expect(spawnsWithoutEnv(`execFileSync("git", args, { cwd: dir, env: gitEnv() });`)).toBe(0);
    expect(spawnsWithoutEnv(`const p = Bun.spawn(["git", "diff"], { cwd });`)).toBe(1);
    expect(spawnsWithoutEnv(`spawnSync("git", ["config", "user.name"], { encoding: "utf8" });`)).toBe(1);
    expect(spawnsWithoutEnv(`execSync("git status", { cwd });`)).toBe(1);
    expect(spawnsWithoutEnv(`execFile("git", ["log"], cb);`)).toBe(1);
    // A call with no options at all is the worst case and the one CI caught.
    expect(spawnsWithoutEnv(`Bun.spawnSync(["git", "rev-parse", "HEAD"]);`)).toBe(1);
    // `exec` is also a method of RegExp: that is not a process.
    expect(spawnsWithoutEnv(`const m = re.exec("git log");`)).toBe(0);
  });

  test("un git scritto come TESTO non e' una chiamata", () => {
    // The four shapes that live in this repo, and the reason the mask exists.
    expect(spawnsWithoutEnv(`const bare = 'execFileSync("git", ["commit"], { cwd });';`)).toBe(0);
    expect(spawnsWithoutEnv("const bare = `execFileSync(\"git\", [\"commit\"], { cwd });`;")).toBe(0);
    expect(spawnsWithoutEnv(`// execFileSync("git", ["commit"], { cwd });`)).toBe(0);
    expect(spawnsWithoutEnv(`/**\n * execFileSync("git", ["commit"], { cwd });\n */`)).toBe(0);
    // And the mask must not swallow the code that FOLLOWS the text: a regex
    // with an odd number of quotes in it used to do exactly that.
    expect(
      spawnsWithoutEnv(`const re = /["']git["']/;\nexecFileSync("git", ["log"], { cwd });`),
    ).toBe(1);
    expect(spawnsWithoutEnv(`const s = "un apostrofo: l'env";\nexecFileSync("git", ["log"], { cwd });`)).toBe(1);
  });

  test("nessun file di test lancia git senza passare un env", () => {
    const offenders: string[] = [];
    for (const rel of trackedTestFiles()) {
      let text: string;
      try {
        text = readFileSync(join(REPO_ROOT, rel), "utf-8");
      } catch {
        continue; // deleted between `ls-files` and here: not an offender
      }
      const n = spawnsWithoutEnv(text);
      if (n > 0) offenders.push(`${rel} (${n})`);
    }
    // If this list is not empty: add `env: gitEnv()` to the spawn, with
    // `import { gitEnv } from "<...>/tests/setup/bun-test-preload"`. It serves
    // to keep out the hooks of the machine of whoever runs it, which otherwise
    // fire on every commit of your test repo.
    expect(offenders).toEqual([]);
  });
});
