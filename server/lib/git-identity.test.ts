import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { gitEnvFor, FALLBACK_GIT_IDENTITY, resetGitIdentityCache } from "./git-identity";

/**
 * Il caso che il banco non poteva vedere: una macchina senza identità git.
 *
 * Non si simula togliendo `~/.gitconfig` (git ripiegherebbe sul nome di sistema,
 * che sul portatile c'è e sul runner è vuoto) ma con `user.useConfigOnly`, che
 * spegne quel ripiego e mette QUALUNQUE macchina nella condizione del runner:
 * l'identità o è configurata o non esiste.
 *
 * @covers GIT-ID-01
 */
function senzaIdentita(): void {
  const dir = mkdtempSync(join(tmpdir(), "git-identity-"));
  const cfg = join(dir, "gitconfig");
  writeFileSync(cfg, "[user]\n\tuseConfigOnly = true\n");
  process.env.GIT_CONFIG_GLOBAL = cfg;
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) {
    delete process.env[k];
  }
  resetGitIdentityCache();
}

afterEach(() => {
  delete process.env.GIT_CONFIG_GLOBAL;
  delete process.env.GIT_CONFIG_SYSTEM;
  resetGitIdentityCache();
});

test("macchina senza identità: git riceve quella di ripiego", async () => {
  senzaIdentita();
  const env = await gitEnvFor(process.cwd());
  expect(env.GIT_COMMITTER_NAME).toBe(FALLBACK_GIT_IDENTITY.name);
  expect(env.GIT_COMMITTER_EMAIL).toBe(FALLBACK_GIT_IDENTITY.email);
  expect(env.GIT_AUTHOR_NAME).toBe(FALLBACK_GIT_IDENTITY.name);
  expect(env.GIT_AUTHOR_EMAIL).toBe(FALLBACK_GIT_IDENTITY.email);
});

test("il ripiego SBLOCCA davvero il comando che git rifiutava (exit 128)", async () => {
  senzaIdentita();
  const repo = mkdtempSync(join(tmpdir(), "git-identity-repo-"));
  const run = async (env: Record<string, string | undefined>, args: string[]) => {
    const p = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe", env });
    await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return p.exited;
  };
  await run(process.env, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "a.txt"), "uno\n");
  await run(process.env, ["add", "-A"]);

  // Senza il ripiego git non parte nemmeno: è ESATTAMENTE il 128 che sul runner
  // faceva raccontare al land «il merge non è nemmeno partito».
  expect(await run(process.env, ["commit", "-q", "-m", "x"])).toBe(128);
  expect(await run(await gitEnvFor(repo), ["commit", "-q", "-m", "x"])).toBe(0);
});

test("macchina CON identità: l'ambiente non si tocca (il merge resta firmato dall'umano)", async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), "git-identity-ok-"));
  const cfg = join(cfgDir, "gitconfig");
  writeFileSync(cfg, "[user]\n\tname = Umano Vero\n\temail = umano@example.com\n");
  process.env.GIT_CONFIG_GLOBAL = cfg;
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  resetGitIdentityCache();

  const env = await gitEnvFor(process.cwd());
  expect(env).toBe(process.env);
});
