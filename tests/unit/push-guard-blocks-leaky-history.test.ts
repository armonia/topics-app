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
  * @covers GATE-07, GATE-21
 */
import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv } from "../setup/bun-test-preload";

const GUARD = join(import.meta.dir, "../../scripts/check-push-clean.ts");
const NAME = "Zzyzx Quiverleaf"; // invented: must not exist anywhere in this repo

function repoWith(
  commits: Array<{ file: string; body: string; message: string }>,
  /** The `.personal-terms` body. Defaults to the plain, blocking-everywhere form;
   *  the forward-only tests need the `>` marker instead. */
  terms = `${NAME}\n# a comment, and a blank line follow\n\n`,
): string {
  const dir = mkdtempSync(join(tmpdir(), "push-guard-"));
  const run = (...args: string[]) => execFileSync("git", args, { env: gitEnv(), cwd: dir, encoding: "utf8" });
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
  // `.terms` must stay OUT of the index: a test that commits with `git add -A`
  // after this point would otherwise sweep it into a commit, and switching back
  // to a branch without it would DELETE the file the gate reads. Measured while
  // writing the tag case: the gate then saw an empty list and reported clean,
  // which looks exactly like a passing gate.
  writeFileSync(join(dir, ".git", "info", "exclude"), ".terms\n");
  writeFileSync(join(dir, ".terms"), terms);
  return dir;
}

/** A bare repo to push to, so "published" means something in a throwaway tree. */
function remoteFor(dir: string): string {
  const bare = mkdtempSync(join(tmpdir(), "push-guard-remote-"));
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["remote", "add", "origin", bare], { cwd: dir });
  return bare;
}

/** Commits carrying `term` under one scope, counted the way the gate counts. */
function reachable(dir: string, term: string, scope: string[]): string[] {
  const run = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).split("\n").filter(Boolean);
  return [...new Set([
    ...run("log", "--format=%H", "-S", term, ...scope),
    ...run("log", "--format=%H", "--grep", term, ...scope),
  ])];
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
    execFileSync("git", ["init", "-q", "--bare", bare], { env: gitEnv() });
    execFileSync("git", ["remote", "add", "origin", bare], { env: gitEnv(), cwd: dir });
    execFileSync("git", ["push", "-q", "--no-verify", "origin", "main"], { env: gitEnv(), cwd: dir });
    expect(scrub(dir).status).toBe(1);
  });

  test("un ref di un remoto che non esiste piu' non pubblica niente", () => {
    const dir = repoWith([{ file: "a.txt", body: `client: ${NAME}\n`, message: "vecchio" }]);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { env: gitEnv(), cwd: dir, encoding: "utf8" }).trim();
    // Exactly the state found on this machine: a refs/remotes/<name>/ ref whose
    // remote is not in `git remote`. `git remote remove` would have swept the
    // refs too, which is why the real one survived: nothing removed the remote,
    // it was simply never configured in this clone.
    execFileSync("git", ["update-ref", "refs/remotes/selfcheck/main", head], { env: gitEnv(), cwd: dir });
    expect(execFileSync("git", ["remote"], { env: gitEnv(), cwd: dir, encoding: "utf8" }).trim()).toBe("");
    expect(scrub(dir).status).toBe(0);
  });
});

/**
 * A TAG PUBLISHES AS MUCH AS A BRANCH, and the gate used to look only at branches.
 *
 * `--remotes=origin/*` is 23 refs on the real clone; the same remote carries 710
 * tags, and the 21/08/2026 rewrite moved `main` without touching one of them.
 * Measured 22/10/2026 on the author's home directory path: 51 commits under the
 * old scope, 112 under the union with the published tags. Three client names
 * reported `pulito` while 14 commits still carried them, all kept alive by one
 * published release tag.
 *
 * The case below is that shape in miniature: the name lives in a commit no
 * branch reaches. The old scope is not asserted from memory, it is MEASURED in
 * the test, so "0 before, red after" is an observation and not a claim.
 */
describe("storia pubblicata: i tag", () => {
  const SCRUB = join(import.meta.dir, "../../scripts/scrub-history.ts");

  function scrub(dir: string, terms = join(dir, ".terms")) {
    return spawnSync("bun", ["run", SCRUB, "--check"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, TOPICS_PERSONAL_TERMS: terms },
    });
  }

  /** A commit that only a tag reaches: branched, tagged, branch deleted. */
  function repoWithTagOnlyLeak(terms?: string): string {
    const dir = repoWith([{ file: "clean.txt", body: "pulito\n", message: "lavoro normale" }], terms);
    const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    run("checkout", "-q", "-b", "da-taggare");
    writeFileSync(join(dir, "leak.txt"), `client: ${NAME}\n`);
    run("add", "-A");
    run("commit", "-q", "-m", "release 1.0");
    run("tag", "v1.0");
    run("checkout", "-q", "main");
    run("branch", "-qD", "da-taggare");
    const bare = remoteFor(dir);
    run("push", "-q", "--no-verify", "origin", "main");
    run("push", "-q", "--no-verify", "origin", "v1.0");
    expect(bare).toBeTruthy();
    return dir;
  }

  test("un nome che solo un TAG pubblicato raggiunge: 0 col vecchio ambito, rosso col nuovo", () => {
    const dir = repoWithTagOnlyLeak();
    // The old scope, measured and not assumed: the branches publish nothing.
    expect(reachable(dir, NAME, ["--remotes=origin/*"])).toHaveLength(0);
    // The commit is published all the same, and the tag is the proof.
    expect(reachable(dir, NAME, ["--remotes=origin/*", "refs/tags/v1.0"])).toHaveLength(1);
    const r = scrub(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("1 commit");
  });

  test("un tag pubblicato che il clone non ha fetchato non diventa un verde", () => {
    // `git log` answers an unresolvable ref with a fatal and NOTHING else, and
    // `git()` swallows errors: one tag named by the remote and missing from the
    // clone does not cost that tag's coverage, it zeroes EVERY count. The case
    // below: the tag is on the remote, not here.
    const dir = repoWithTagOnlyLeak();
    execFileSync("git", ["tag", "-d", "v1.0"], { cwd: dir });
    const r = scrub(dir);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("non misurabile");
    expect(r.stdout).not.toContain("niente di pubblicato contiene i nomi");
  });

  test("un leak certo batte un tag non fetchato: esce 1, non 2", () => {
    // Two published tags, one missing locally, and the leak sits under the one
    // that is here. Red wins: it is the certain news, and it has a cure.
    const dir = repoWithTagOnlyLeak();
    const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    run("tag", "v2.0", "v1.0");
    run("push", "-q", "--no-verify", "origin", "v2.0");
    run("tag", "-d", "v2.0");
    const r = scrub(dir);
    expect(r.status).toBe(1);
  });

  test("un tag LOCALE non pubblica niente", () => {
    // Same leak, but the tag stays here: the remote has only `main`. A local
    // `archive/*` backup tag is the common case (316 of them on the real clone)
    // and counting it would announce a public leak on a ref nobody can fetch.
    const dir = repoWith([{ file: "clean.txt", body: "pulito\n", message: "normale" }]);
    const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    run("checkout", "-q", "-b", "da-taggare");
    writeFileSync(join(dir, "leak.txt"), `client: ${NAME}\n`);
    run("add", "-A");
    run("commit", "-q", "-m", "solo qui");
    run("tag", "archive/backup");
    run("checkout", "-q", "main");
    run("branch", "-qD", "da-taggare");
    remoteFor(dir);
    run("push", "-q", "--no-verify", "origin", "main");
    const r = scrub(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("SOLO locali");
  });
});

/**
 * TWO TIERS, because one tier meant the list could not grow.
 *
 * A term already in the published history makes the history gate red forever:
 * the only cure is a rewrite, and a rewrite is measured not to work (GitHub kept
 * serving objects from the 21/08/2026 force-push 62 days later). So the term
 * that was worth blocking in NEW commits simply never got added, and the
 * author's home directory path leaked into a launchd plist in PR #405 with
 * nothing looking for it.
 *
 * `> term` means: do not fail over the history, keep refusing it in anything not
 * yet pushed. The second half is the one that can still prevent something, so
 * both halves are watched here, message included.
 */
describe("termini solo in avanti", () => {
  const SCRUB = join(import.meta.dir, "../../scripts/scrub-history.ts");
  const GUARD2 = join(import.meta.dir, "../../scripts/check-push-clean.ts");
  const FORWARD = `> ${NAME}   # esposizione nota\n`;

  test("il marcatore si legge, e il termine resta nella lista", () => {
    const dir = mkdtempSync(join(tmpdir(), "push-guard-terms-"));
    writeFileSync(join(dir, ".terms"), `Normale\n> Avanti   # nota\n>\n# commento\n`);
    const r = spawnSync("bun", ["-e", `
      import { personalTermEntries, personalTerms } from ${JSON.stringify(join(import.meta.dir, "../../scripts/personal-terms.ts"))};
      console.log(JSON.stringify({ e: personalTermEntries("/nowhere"), t: personalTerms("/nowhere") }));
    `], { encoding: "utf8", env: { ...process.env, TOPICS_PERSONAL_TERMS: join(dir, ".terms") } });
    const out = JSON.parse(r.stdout.trim());
    expect(out.e).toEqual([
      { term: "Normale", forwardOnly: false },
      { term: "Avanti", forwardOnly: true },
    ]);
    // The push guard reads this one, and must see BOTH terms: the marker changes
    // the history verdict, never what a push is allowed to add.
    expect(out.t).toEqual(["Normale", "Avanti"]);
  });

  test("nella storia PUBBLICATA non fa rosso, e la nomina col conteggio", () => {
    const dir = repoWith([{ file: "a.txt", body: `client: ${NAME}\n`, message: "pubblicato" }], FORWARD);
    remoteFor(dir);
    execFileSync("git", ["push", "-q", "--no-verify", "origin", "main"], { cwd: dir });
    const r = spawnSync("bun", ["run", SCRUB, "--check"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, TOPICS_PERSONAL_TERMS: join(dir, ".terms") },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("esposizione NOTA");
    expect(r.stdout).toContain(NAME);
    expect(r.stdout).toContain("1 commit");
  });

  test("senza il marcatore lo stesso termine e lo stesso repo sono rossi", () => {
    // The pair that proves the marker is what changed the verdict, not the repo.
    const dir = repoWith([{ file: "a.txt", body: `client: ${NAME}\n`, message: "pubblicato" }]);
    remoteFor(dir);
    execFileSync("git", ["push", "-q", "--no-verify", "origin", "main"], { cwd: dir });
    const r = spawnSync("bun", ["run", SCRUB, "--check"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, TOPICS_PERSONAL_TERMS: join(dir, ".terms") },
    });
    expect(r.status).toBe(1);
  });

  function pushGuard(dir: string) {
    return spawnSync("bun", ["run", GUARD2, "--range", "HEAD", "--not", "--remotes=origin/*"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, TOPICS_PERSONAL_TERMS: join(dir, ".terms") },
    });
  }

  test("in un commit NON pushato e' rosso: contenuto", () => {
    const dir = repoWith([{ file: "clean.txt", body: "pulito\n", message: "normale" }], FORWARD);
    remoteFor(dir);
    execFileSync("git", ["push", "-q", "--no-verify", "origin", "main"], { cwd: dir });
    const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    writeFileSync(join(dir, "new.txt"), `path: ${NAME}\n`);
    run("add", "-A");
    run("commit", "-q", "-m", "niente di che");
    const r = pushGuard(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("niente di che");
  });

  test("in un commit NON pushato e' rosso anche se sta solo nel MESSAGGIO", () => {
    const dir = repoWith([{ file: "clean.txt", body: "pulito\n", message: "normale" }], FORWARD);
    remoteFor(dir);
    execFileSync("git", ["push", "-q", "--no-verify", "origin", "main"], { cwd: dir });
    const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    writeFileSync(join(dir, "new.txt"), "niente di che\n");
    run("add", "-A");
    run("commit", "-q", "-m", `fix in ${NAME}`);
    const r = pushGuard(dir);
    expect(r.status).toBe(1);
  });

  test("un marcatore su un termine che la storia non ha lo dice invece di tacere", () => {
    const dir = repoWith([{ file: "a.txt", body: "pulito\n", message: "normale" }], FORWARD);
    remoteFor(dir);
    execFileSync("git", ["push", "-q", "--no-verify", "origin", "main"], { cwd: dir });
    const r = spawnSync("bun", ["run", SCRUB, "--check"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, TOPICS_PERSONAL_TERMS: join(dir, ".terms") },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("il marcatore non serve");
  });
});
