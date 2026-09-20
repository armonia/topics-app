/**
 * IL CANCELLO CHE SEGNALAVA SE STESSO.
 *
 * Il 20/09 un `git push` di due commit ha stampato, dentro lo stesso comando
 * che li stava pubblicando, "main ha 2 commit non spinti -> git push". Non e'
 * un falso positivo qualsiasi: e' un avviso che compare a OGNI push, perche'
 * durante il pre-push i commit in arrivo non sono ancora sul remoto e
 * `git rev-list upstream..main` li conta per forza. Un cancello che parla
 * sempre insegna a non leggerlo, e il giorno che ha qualcosa di vero da dire
 * nessuno lo guarda.
 *
 * Qui si misura su un repo vero con un remoto vero (un clone `--bare` su
 * disco), perche' il difetto sta proprio nel rapporto fra `main` e il suo
 * upstream: con un finto non esisterebbe.
 *
 * LE DUE META' DELLA STESSA PROVA, e servono entrambe:
 *  - senza `--in-push` il conteggio DEVE ancora vedere i commit (altrimenti il
 *    rimedio sarebbe "smetti di contare", e il cancello morirebbe zitto);
 *  - con `--in-push <sha>` deve tacere su QUEL carico e non su altro.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "check-repo-pulito.ts");

const lavoro = mkdtempSync(join(tmpdir(), "pulito-push-"));
afterAll(() => rmSync(lavoro, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      // Gli hook del repo vero non devono girare dentro il banco di prova.
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  }
  return r.stdout.toString().trim();
}

/** Un repo con upstream e due commit locali non spinti, come al momento del push. */
function bancoDiProva(): { repo: string; shas: string[] } {
  const remoto = join(lavoro, "remoto.git");
  const repo = join(lavoro, "lavoro");
  git(lavoro, "init", "--bare", "--initial-branch=main", remoto);
  git(lavoro, "clone", remoto, repo);

  writeFileSync(join(repo, "a.txt"), "uno\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-m", "base");
  git(repo, "push", "-u", "origin", "main");

  const shas: string[] = [];
  for (const n of ["due", "tre"]) {
    writeFileSync(join(repo, "a.txt"), `${n}\n`);
    git(repo, "commit", "-am", n);
    shas.push(git(repo, "rev-parse", "HEAD"));
  }
  return { repo, shas };
}

function conta(repo: string, ...args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(["bun", "run", SCRIPT, ...args], {
    cwd: repo,
    env: { ...process.env, TOPICS_PULITO_OK: "" },
  });
  return {
    code: r.exitCode ?? 1,
    out: r.stdout.toString() + r.stderr.toString(),
  };
}

const { repo, shas } = bancoDiProva();

test("senza --in-push i commit non spinti si vedono ancora", () => {
  const { code, out } = conta(repo);
  expect(out).toContain("commit non spinti");
  expect(code).not.toBe(0);
});

test("con --in-push il carico del push non viene segnalato come avanzo", () => {
  // git passa la PUNTA del ramo: `--not <punta>` esclude anche i suoi antenati.
  const { code, out } = conta(repo, "--in-push", shas[shas.length - 1]!);
  expect(out).not.toContain("commit non spinti");
  expect(code).toBe(0);
});

test("uno sha finto non spegne il conteggio", () => {
  // Una cancellazione di ramo arriva come sha di zeri: non pubblica niente, e
  // se venisse passata a `--not` il conteggio tacerebbe per il motivo sbagliato.
  const { out } = conta(repo, "--in-push", "0000000000000000000000000000000000000000");
  expect(out).toContain("commit non spinti");
});
