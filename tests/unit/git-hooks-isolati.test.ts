/**
 * La guardia dell'isolamento git nei test.
 *
 * Il guasto che protegge: diciassette file di test costruiscono repo git veri
 * e ci fanno 46 commit, ereditando la config della macchina. Su questa,
 * `core.hooksPath` punta a un hook di terze parti che a ogni commit chiama
 * `localhost:3333` con due `curl --max-time 2`. Il risultato era un rosso che
 * compariva SOLO nella suite intera, su un test diverso ogni volta, con
 * l'errore «this test timed out after 5000ms»: sembrava una collisione fra
 * test, era la macchina che entrava dentro.
 *
 * Perche' una guardia e non solo il fix: l'isolamento vive in un preload che
 * nessuno guarda, e la riga che lo applica (`env: gitEnv()`) e' facile da
 * dimenticare nel prossimo file che nascera'. Qui si misura l'effetto, non la
 * presenza del codice.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gitEnv } from "../setup/bun-test-preload";

function gitOut(args: string[], opts: { env?: Record<string, string>; cwd?: string } = {}): string {
  const r = Bun.spawnSync(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd,
    env: opts.env,
  });
  return new TextDecoder().decode(r.stdout).trim();
}

describe("i test non ereditano gli hook git della macchina", () => {
  test("gitEnv() impone un hooksPath che non esiste", () => {
    // Non la stringa vuota: git la risolverebbe come percorso relativo al repo
    // e finirebbe per usare `<repo>/.git/hooks`, cioe' proprio cio' che si
    // vuole evitare. Misurato: tornava `/Users/.../topics-app/.git/hooks`.
    expect(gitOut(["config", "--get", "core.hooksPath"], { env: gitEnv() })).toBe(
      "/nonexistent/topics-test-hooks",
    );
  });

  test("gitEnv() spegne la firma dei commit", () => {
    // Chi firma i commit non deve vedersi chiedere la passphrase da una suite
    // di test: il prompt non arriva a nessuno e il test resta appeso.
    expect(gitOut(["config", "--get", "commit.gpgsign"], { env: gitEnv() })).toBe("false");
  });

  test("un commit vero riesce, senza identita' configurata sulla macchina", () => {
    // L'isolamento non deve rompere cio' che isola: git rifiuta di committare
    // senza `user.email`, quindi `gitEnv()` ne fornisce una finta.
    const d = mkdtempSync(join(tmpdir(), "guardia-hook-"));
    Bun.spawnSync(["git", "-C", d, "init", "-q", "-b", "main"], { env: gitEnv() });
    writeFileSync(join(d, "f.txt"), "x");
    Bun.spawnSync(["git", "-C", d, "add", "-A"], { env: gitEnv() });
    const r = Bun.spawnSync(["git", "-C", d, "commit", "-q", "-m", "prova"], {
      stdout: "pipe",
      stderr: "pipe",
      env: gitEnv(),
    });
    expect(r.exitCode).toBe(0);
  });

  test("gitEnv() accetta aggiunte senza perdere le chiavi di git", () => {
    // Chi ha bisogno di una variabile propria non deve ricostruire l'ambiente
    // a mano: farlo e' il modo in cui l'isolamento si perde di nuovo.
    const env = gitEnv({ MIA_VARIABILE: "42" });
    expect(env.MIA_VARIABILE).toBe("42");
    expect(gitOut(["config", "--get", "core.hooksPath"], { env })).toBe("/nonexistent/topics-test-hooks");
  });

  test("il preload da solo NON basta: senza env esplicito l'isolamento si perde", () => {
    // Questa e' la lezione che costa: `Bun.spawnSync` non eredita cio' che il
    // preload ha aggiunto a `process.env` a runtime. Se un giorno bun cambiasse
    // idea, questo test diventerebbe rosso ed e' giusto cosi': vorrebbe dire
    // che `env: gitEnv()` non serve piu', e questa guardia va riscritta.
    expect(gitOut(["config", "--get", "core.hooksPath"])).not.toBe("/nonexistent/topics-test-hooks");
  });
});
