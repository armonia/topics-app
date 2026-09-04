/**
 * The automatic per-turn checkpoint, measured against a REAL repository.
 *
 * Every claim this module makes is a claim about git's own state - where the
 * ref lives, whether HEAD is still on a branch, whether the user's index moved.
 * A fake would just be the test asserting what the author believes git does,
 * which is precisely how the `checkout` defect survived in the manual
 * checkpoint route until it was measured. So: a temp repo, real commands.
 *
 * @covers CHAT-05
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECKPOINT_REF_ROOT,
  captureTurnCheckpoint,
  listTurnCheckpoints,
  restoreTurnCheckpoint,
  dropTurnCheckpoints,
  sessionRefSlug,
  runGit,
  GIT_TIMEOUT_MS,
} from "./turn-checkpoints";

let repo: string;
const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
const SESSION = "topic-42/session";

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "topics-turnckpt-"));
  git("init", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "f.txt"), "prima\n");
  git("add", "-A");
  git("commit", "-m", "uno");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("cattura", () => {
  test("scrive un ref sotto refs/topics/checkpoints, non un ramo", async () => {
    const c = await captureTurnCheckpoint(repo, SESSION, "turno 1");
    expect(c).not.toBeNull();
    expect(c!.ref.startsWith(CHECKPOINT_REF_ROOT + "/")).toBe(true);

    // The point of decision 1: invisible to the commands the user lives in.
    expect(git("branch", "--list")).not.toContain("checkpoint");
    expect(git("log", "--oneline")).toBe(git("log", "--oneline", "main"));
  });

  test("non tocca l'indice dell'utente", async () => {
    // Staged work must survive a snapshot untouched: the capture runs on a
    // temporary GIT_INDEX_FILE precisely so this holds.
    writeFileSync(join(repo, "staged.txt"), "in stage\n");
    git("add", "staged.txt");
    const indexBefore = git("status", "--porcelain");

    await captureTurnCheckpoint(repo, SESSION, "turno 1");
    expect(git("status", "--porcelain")).toBe(indexBefore);
  });

  test("un turno che non cambia niente non crea un secondo checkpoint", async () => {
    await captureTurnCheckpoint(repo, SESSION, "turno 1");
    const second = await captureTurnCheckpoint(repo, SESSION, "turno 2");
    expect(second, "albero identico: niente da registrare").toBeNull();
    expect((await listTurnCheckpoints(repo, SESSION)).length).toBe(1);
  });

  test("un path che non e' un repo git non e' un errore, e' un null", async () => {
    const plain = mkdtempSync(join(tmpdir(), "topics-norepo-"));
    try {
      expect(await captureTurnCheckpoint(plain, SESSION, "turno")).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  /**
   * THE PRUNING, MEASURED WITH A SMALL CEILING instead of the production 50.
   *
   * Every round here is a real commit on a real repository, and at the default
   * that is 55 of them: the test timed out at 30 s on any busy machine (30.3 s
   * and 30.4 s, two runs on 2026-09-04) and took four unrelated cards down with
   * it. What it has to show - the newest `keep` survive and the older ones go -
   * does not depend on that number being 50, so the number is injected and the
   * proof costs eight rounds.
   *
   * `dir` is bound locally on purpose, and it is the other half of the fix. A
   * test the runner has already given up on KEEPS RUNNING: this loop used to
   * read the shared `repo` on every round, which by then was the NEXT test's
   * fresh repository, and wrote into it. That is how one timeout here surfaced
   * as a failure two tests down, in a test that passes on its own.
   */
  test("la potatura tiene gli ultimi keep, i piu' vecchi se ne vanno", async () => {
    const dir = repo;
    const keep = 3;
    const rounds = 6;
    for (let i = 0; i < rounds; i++) {
      writeFileSync(join(dir, "f.txt"), `giro ${i}\n`);
      await captureTurnCheckpoint(dir, SESSION, `turno ${i}`, keep);
    }
    const all = await listTurnCheckpoints(dir, SESSION);
    expect(all.length).toBe(keep);
    expect(all[0].label, "il piu' recente e' il primo").toBe(`turno ${rounds - 1}`);
    expect(all[all.length - 1].label, "i giri piu' vecchi sono stati potati").toBe(`turno ${rounds - keep}`);
  });
});

describe("ripristino", () => {
  test("riporta il contenuto del file modificato dal turno", async () => {
    await captureTurnCheckpoint(repo, SESSION, "prima del turno");
    writeFileSync(join(repo, "f.txt"), "scritto dal turno\n");

    const [ckpt] = await listTurnCheckpoints(repo, SESSION);
    const out = await restoreTurnCheckpoint(repo, ckpt.commit);

    expect(readFileSync(join(repo, "f.txt"), "utf8")).toBe("prima\n");
    expect(out.restored).toBeGreaterThan(0);
  });

  test("cancella i file che il turno ha creato", async () => {
    await captureTurnCheckpoint(repo, SESSION, "prima del turno");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "nuovo.ts"), "export const x = 1\n");

    const [ckpt] = await listTurnCheckpoints(repo, SESSION);
    const out = await restoreTurnCheckpoint(repo, ckpt.commit);

    expect(existsSync(join(repo, "src", "nuovo.ts")), "il file nato nel turno resta indietro").toBe(false);
    expect(out.removed).toBe(1);
  });

  test("NON lascia il repository in detached HEAD", async () => {
    // The half of the defect that shipped. `symbolic-ref` fails on a detached
    // HEAD, so this is the assertion that catches a regression to `checkout`.
    await captureTurnCheckpoint(repo, SESSION, "prima del turno");
    writeFileSync(join(repo, "f.txt"), "scritto dal turno\n");

    const [ckpt] = await listTurnCheckpoints(repo, SESSION);
    const out = await restoreTurnCheckpoint(repo, ckpt.commit);

    expect(out.branch).toBe("main");
    expect(git("symbolic-ref", "HEAD")).toBe("refs/heads/main");
  });

  test("`checkout <hash>` invece STACCA la testa: la non-vacuita' del test sopra", async () => {
    const c = await captureTurnCheckpoint(repo, SESSION, "prima del turno");
    expect(() => git("checkout", c!.commit), "se questo non staccasse, il difetto non esisteva").not.toThrow();
    expect(() => git("symbolic-ref", "HEAD")).toThrow();
  });

  test("dichiara che la conversazione NON torna indietro", async () => {
    // Decision 3 on the wire. Two different promises; this module keeps one and
    // says so, rather than letting a caller imply the other.
    await captureTurnCheckpoint(repo, SESSION, "prima del turno");
    writeFileSync(join(repo, "f.txt"), "scritto dal turno\n");
    const [ckpt] = await listTurnCheckpoints(repo, SESSION);
    expect((await restoreTurnCheckpoint(repo, ckpt.commit)).conversationRewound).toBe(false);
  });
});

describe("igiene dei ref", () => {
  test("una chiave di sessione qualsiasi diventa un nome di ref valido", async () => {
    const nasty = "../ ..refs\\weird:name.lock";
    expect(sessionRefSlug(nasty)).not.toContain("..");
    expect(sessionRefSlug(nasty)).not.toMatch(/\.lock$/);
    const c = await captureTurnCheckpoint(repo, nasty, "turno");
    expect(c).not.toBeNull();
    expect(git("rev-parse", "--verify", c!.ref)).toBe(c!.commit);
  });

  test("la chiusura della sessione spazza via il suo namespace", async () => {
    await captureTurnCheckpoint(repo, SESSION, "turno 1");
    expect(await dropTurnCheckpoints(repo, SESSION)).toBe(1);
    expect(await listTurnCheckpoints(repo, SESSION)).toEqual([]);
  });
});

/**
 * A GIT THAT NEVER COMES BACK MUST NOT TAKE THE TURN WITH IT.
 *
 * The checkpoint runs on the user's turn, before the agent may write anything,
 * and git is not a pure computation: it takes `index.lock`. Another process
 * holding that lock (a second agent on the same repository, an editor, a
 * crashed git that left the file behind) used to park the turn there forever,
 * with no ceiling and not one line in the log to explain the silence. It is
 * the same shape of failure as the boot resume waiting on a route that never
 * answers, and it gets the same answer: a ceiling, a kill, and a spoken reason.
 *
 * The stand-in for the lock is a `git` on PATH that sleeps: what is under test
 * is our ceiling, not git's locking, and this way the proof costs 200 ms
 * instead of thirty seconds.
 */
describe("un git appeso viene ucciso e lo dice", () => {
  let fakeDir: string;
  let realPath: string | undefined;

  beforeEach(() => {
    fakeDir = mkdtempSync(join(tmpdir(), "git-fakeDir-"));
    writeFileSync(join(fakeDir, "git"), "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    realPath = process.env.PATH;
    process.env.PATH = `${fakeDir}:${realPath ?? ""}`;
  });

  afterEach(() => {
    if (realPath === undefined) delete process.env.PATH; else process.env.PATH = realPath;
    try { rmSync(fakeDir, { recursive: true, force: true }); } catch { /* scratch */ }
  });

  test("torna entro il tetto invece di aspettare per sempre", async () => {
    const started = Date.now();
    const r = await runGit(["status"], fakeDir, undefined, 150);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("timed out");
  });

  test("il tetto di produzione lascia respirare un repository grande", () => {
    expect(GIT_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });
});
