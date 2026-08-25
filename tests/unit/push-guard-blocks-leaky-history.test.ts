/**
 * The push guard must be able to say no.
 *
 * A gate nobody has seen fail is not a gate, and this one is unusually easy to
 * get wrong in the reassuring direction: its input is `.personal-terms`, a file
 * that deliberately does not exist in CI, so "exits 0" is its normal state and
 * proves nothing. These tests hand it a throwaway repo and a made-up name, so
 * red and green are both observed.
 *
 * The two cases are not one case twice. `git log -S` looks at content and never
 * sees a name that appears only in a commit MESSAGE; the real rewrite of
 * 2026-08-21 left 15 such messages behind while the content check read clean.
  * @covers GATE-07
 */
import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GUARD = join(import.meta.dir, "../../scripts/check-push-clean.ts");
const NAME = "Zzyzx Quiverleaf"; // invented: must not exist anywhere in this repo

function repoWith(commits: Array<{ file: string; body: string; message: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), "push-guard-"));
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "t@example.com");
  run("config", "user.name", "T");
  writeFileSync(join(dir, "base.txt"), "base\n");
  run("add", "-A");
  run("commit", "-q", "-m", "base");
  for (const c of commits) {
    writeFileSync(join(dir, c.file), c.body);
    run("add", "-A");
    run("commit", "-q", "-m", c.message);
  }
  writeFileSync(join(dir, ".terms"), `${NAME}\n# a comment, and a blank line follow\n\n`);
  return dir;
}

function guard(dir: string, range: string[]) {
  return spawnSync("bun", ["run", GUARD, "--range", ...range], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, TOPICS_PERSONAL_TERMS: join(dir, ".terms") },
  });
}

describe("push guard", () => {
  test("blocca un commit che PUBBLICA il nome nel contenuto", () => {
    const dir = repoWith([{ file: "a.txt", body: `client: ${NAME}\n`, message: "aggiungo il file" }]);
    const r = guard(dir, ["HEAD", "--not", "HEAD~1"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("aggiungo il file");
  });

  test("blocca un commit che ha il nome solo nel MESSAGGIO", () => {
    const dir = repoWith([{ file: "a.txt", body: "niente di che\n", message: `lavoro per ${NAME}` }]);
    const r = guard(dir, ["HEAD", "--not", "HEAD~1"]);
    expect(r.status).toBe(1);
  });

  test("lascia passare una storia pulita", () => {
    const dir = repoWith([{ file: "a.txt", body: "niente di che\n", message: "lavoro normale" }]);
    expect(guard(dir, ["HEAD", "--not", "HEAD~1"]).status).toBe(0);
  });

  test("ignora i commit GIA' sul remoto: guarda solo cosa aggiunge il push", () => {
    const dir = repoWith([
      { file: "a.txt", body: `client: ${NAME}\n`, message: "vecchio, gia' pubblicato" },
      { file: "b.txt", body: "pulito\n", message: "nuovo" },
    ]);
    expect(guard(dir, ["HEAD", "--not", "HEAD~1"]).status).toBe(0);
    expect(guard(dir, ["HEAD", "--not", "HEAD~2"]).status).toBe(1);
  });

  test("senza elenco di nomi esce zero invece di fingere di aver guardato", () => {
    const dir = repoWith([{ file: "a.txt", body: `client: ${NAME}\n`, message: "x" }]);
    const r = spawnSync("bun", ["run", GUARD, "--range", "HEAD", "--not", "HEAD~1"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, TOPICS_PERSONAL_TERMS: join(dir, "non-esiste") },
    });
    expect(r.status).toBe(0);
  });
});

/**
 * The published-history gate, and the ref that made it lie.
 *
 * `check:history-clean` used to ask `git log --all`, which on this machine means
 * 268 local branches: red forever, and therefore read by nobody. It now asks
 * only the refs of remotes that are actually configured. That last word is not
 * decoration: a leftover `selfcheck/main`, from a remote removed right after the
 * rewrite was verified, made the gate announce 9 PUBLIC dirty commits on a
 * remote that no longer existed.
 */
describe("gate della storia pubblicata", () => {
  const SCRUB = join(import.meta.dir, "../../scripts/scrub-history.ts");

  function scrub(dir: string) {
    return spawnSync("bun", ["run", SCRUB, "--check"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, TOPICS_PERSONAL_TERMS: join(dir, ".terms") },
    });
  }

  test("un nome che sta solo in un ramo LOCALE non e' una fuga", () => {
    const dir = repoWith([{ file: "a.txt", body: `client: ${NAME}\n`, message: "solo qui" }]);
    const r = scrub(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("SOLO locali");
  });

  test("lo stesso nome su un remoto configurato e' rosso", () => {
    const dir = repoWith([{ file: "a.txt", body: `client: ${NAME}\n`, message: "pubblicato" }]);
    const bare = mkdtempSync(join(tmpdir(), "push-guard-remote-"));
    execFileSync("git", ["init", "-q", "--bare", bare]);
    execFileSync("git", ["remote", "add", "origin", bare], { cwd: dir });
    execFileSync("git", ["push", "-q", "--no-verify", "origin", "main"], { cwd: dir });
    expect(scrub(dir).status).toBe(1);
  });

  test("un ref di un remoto che non esiste piu' non pubblica niente", () => {
    const dir = repoWith([{ file: "a.txt", body: `client: ${NAME}\n`, message: "vecchio" }]);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    // Exactly the state found on this machine: a refs/remotes/<name>/ ref whose
    // remote is not in `git remote`. `git remote remove` would have swept the
    // refs too, which is why the real one survived: nothing removed the remote,
    // it was simply never configured in this clone.
    execFileSync("git", ["update-ref", "refs/remotes/selfcheck/main", head], { cwd: dir });
    expect(execFileSync("git", ["remote"], { cwd: dir, encoding: "utf8" }).trim()).toBe("");
    expect(scrub(dir).status).toBe(0);
  });
});
