/**
 * @covers WORKTREE-08
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { resolveWorktreeBaseRef } from "./worktree-base-ref";
import type { GitRunResult } from "./own-commits";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gitEnv } from "../../tests/setup/bun-test-preload";

function git(cwd: string, ...args: string[]): void {
  Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
}

/**
 * Due repo VERI, perché la domanda che si vuole provare è proprio quella che
 * fa git: `rev-parse --verify refs/heads/main`. Un finto runner proverebbe solo
 * che il codice legge un `code`, non che chiede la cosa giusta.
 *
 *   conMain     main + un altro ramo checkato out (il caso del checkout condiviso)
 *   senzaMain   ramo unico `sviluppo`, nessun `main`
 */
describe("worktree-base-ref — su git vero", () => {
  let root: string;
  let conMain: string;
  let senzaMain: string;

  // Timeout largo: qui girano una decina di `git` sincroni, e i 5s di default
  // di bun li coprono solo a macchina scarica (stessa ragione di own-commits).
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "wt-base-ref-"));

    conMain = join(root, "con-main");
    Bun.spawnSync(["git", "init", "-q", "-b", "main", conMain], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
    git(conMain, "config", "user.email", "t@t");
    git(conMain, "config", "user.name", "t");
    writeFileSync(join(conMain, "a.txt"), "base");
    git(conMain, "add", "-A");
    git(conMain, "commit", "-q", "-m", "base");
    // Il difetto in scena: il checkout condiviso NON è su main, è sul ramo di
    // un'altra sessione. È esattamente lo stato in cui `HEAD` mentiva.
    git(conMain, "checkout", "-q", "-b", "altra-sessione");
    writeFileSync(join(conMain, "b.txt"), "lavoro altrui");
    git(conMain, "add", "-A");
    git(conMain, "commit", "-q", "-m", "commit di un'altra card");

    senzaMain = join(root, "senza-main");
    Bun.spawnSync(["git", "init", "-q", "-b", "sviluppo", senzaMain], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
    git(senzaMain, "config", "user.email", "t@t");
    git(senzaMain, "config", "user.name", "t");
    writeFileSync(join(senzaMain, "a.txt"), "base");
    git(senzaMain, "add", "-A");
    git(senzaMain, "commit", "-q", "-m", "base");
  }, 30_000);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("repo con main → main, anche se il checkout è su un altro ramo", async () => {
    const r = await resolveWorktreeBaseRef(conMain);
    expect(r.baseRef).toBe("main");
    expect(r.fallback).toBe(false);
  });

  test("repo senza main → HEAD, e il ripiego è dichiarato", async () => {
    const r = await resolveWorktreeBaseRef(senzaMain);
    expect(r.baseRef).toBe("HEAD");
    expect(r.fallback).toBe(true);
    expect(r.reason).toContain("main");
  });

  test("un ramo che si chiama main solo sul REMOTE non basta: non è checkout-abile", async () => {
    // `origin/main` esiste, `refs/heads/main` no: un worktree non può nascere da
    // un ref remoto, quindi la risposta giusta resta il ripiego.
    git(senzaMain, "update-ref", "refs/remotes/origin/main", "HEAD");
    const r = await resolveWorktreeBaseRef(senzaMain);
    expect(r.baseRef).toBe("HEAD");
    expect(r.fallback).toBe(true);
  });

  test("progetto senza path di repo → HEAD, senza chiamare git", async () => {
    let chiamate = 0;
    const runGit = async (): Promise<GitRunResult> => {
      chiamate++;
      return { code: 0, stdout: "" };
    };
    const r = await resolveWorktreeBaseRef(undefined, { runGit });
    expect(r.baseRef).toBe("HEAD");
    expect(r.fallback).toBe(true);
    expect(chiamate).toBe(0);
  });

  test("git che non risponde → HEAD, mai un'eccezione in faccia al dispatch", async () => {
    const runGit = async (): Promise<GitRunResult> => ({ code: 128, stdout: "", stderr: "not a git repository" });
    const r = await resolveWorktreeBaseRef("/non/esiste", { runGit });
    expect(r.baseRef).toBe("HEAD");
    expect(r.fallback).toBe(true);
  });

  test("il ramo d'integrazione è un parametro: mainRef diverso → quello", async () => {
    git(conMain, "branch", "trunk", "main");
    const r = await resolveWorktreeBaseRef(conMain, { mainRef: "trunk" });
    expect(r.baseRef).toBe("trunk");
    expect(r.fallback).toBe(false);
  });
});
