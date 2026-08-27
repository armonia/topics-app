/**
 * `POST /api/git/commit` su una macchina SENZA identità git.
 *
 * Il guard statico accanto (`lib/git-identity-callsites.test.ts`) sorveglia che
 * la chiamata porti un `env`; questo banco verifica l'unica cosa che conta per
 * chi usa il pannello Git: che il commit RIESCA dove git si rifiuterebbe di
 * partire. Sono due domande diverse — un `env` passato male supererebbe il
 * primo e cadrebbe qui.
 *
 * DUE trappole, entrambe pagate scrivendo questo file il 16/08:
 *
 *  1. Non si simula togliendo `~/.gitconfig`: git ripiegherebbe sul nome di
 *     sistema, che sul portatile c'è e sul runner è vuoto. Serve
 *     `user.useConfigOnly`, che spegne quel ripiego (come `lib/git-identity.test.ts`).
 *
 *  2. Non si simula ripulendo `process.env` e chiamando la route IN-PROCESSO:
 *     `Bun.spawn` senza `env` passa al figlio l'ambiente fotografato all'AVVIO
 *     del processo, quindi il git della route continuerebbe a vedere la config
 *     di chi esegue i test. La prima versione di questo banco passava anche col
 *     fix rimosso, cioè non misurava niente. Da qui l'harness in
 *     `files.git-commit-harness.ts`, lanciato come processo separato con
 *     l'ambiente pulito fin dalla nascita.
 *
 * Rosso misurato: nightly del 16/08, FILE-17 «git commit rifiutato dal server:
 * Author identity unknown … fatal: empty ident name (for <runner@…>) not allowed».
 * @covers FILE-02
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HARNESS = join(import.meta.dir, "files.git-commit-harness.ts");

/** L'ambiente di una macchina che non sa firmare: è quello con cui i figli NASCONO. */
function envWithoutIdentity(cfgDir: string): Record<string, string> {
  const cfg = join(cfgDir, "gitconfig");
  writeFileSync(cfg, "[user]\n\tuseConfigOnly = true\n");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GIT_") || v === undefined) continue;
    env[k] = v;
  }
  env.GIT_CONFIG_GLOBAL = cfg;
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  return env;
}

async function run(cmd: string[], cwd: string, env: Record<string, string>) {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code: await p.exited, stdout: stdout.trim(), stderr: stderr.trim() };
}

describe("POST /api/git/commit senza identità git sulla macchina", () => {
  let repo: string, cfgDir: string, env: Record<string, string>;

  beforeEach(async () => {
    cfgDir = mkdtempSync(join(tmpdir(), "git-commit-cfg-"));
    env = envWithoutIdentity(cfgDir);
    repo = mkdtempSync(join(tmpdir(), "git-commit-repo-"));
    await run(["git", "init", "-q", "-b", "main"], repo, env);
    writeFileSync(join(repo, "a.txt"), "uno\n");
    await run(["git", "add", "-A"], repo, env);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(cfgDir, { recursive: true, force: true });
  });

  test("la condizione è davvero quella del runner (git da solo esce 128)", async () => {
    // Se questa cadesse, i due test sotto passerebbero per il motivo sbagliato:
    // misurerebbero una macchina che sa firmare.
    const r = await run(["git", "commit", "-q", "-m", "controllo"], repo, env);
    expect(r.code, "git dovrebbe rifiutarsi di firmare in questo ambiente").toBe(128);
    // Il testo esatto dipende da COME manca l'identità: `useConfigOnly` produce
    // «no email was given and auto-detection is disabled», il runner senza
    // gitconfig «empty ident name (for <runner@…>) not allowed». La riga comune
    // alle due — e quella che FILE-17 ha riportato dalla nightly — è questa.
    expect(r.stderr).toContain("Author identity unknown");
  });

  test("il commit riesce e l'albero resta pulito", async () => {
    const r = await run(["bun", HARNESS, repo, "e2e test commit"], repo, env);
    expect(r.stderr, "l'harness non deve morire").not.toContain("error:");
    const out = JSON.parse(r.stdout);
    expect(out.body.error, "il commit non deve essere rifiutato per identità mancante").toBeUndefined();
    expect(out.status).toBe(200);
    expect(out.body.ok).toBe(true);

    // L'albero è pulito: è ciò che il pannello mostra come «Albero di lavoro pulito».
    const st = await run(["git", "status", "--porcelain"], repo, env);
    expect(st.stdout).toBe("");
  });

  test("l'identità di ripiego firma il commit, non un nome vuoto", async () => {
    await run(["bun", HARNESS, repo, "firma"], repo, env);
    const log = await run(["git", "log", "-1", "--pretty=%an <%ae>"], repo, env);
    expect(log.stdout).toBe("Topics App <topics@localhost>");
  });
});
