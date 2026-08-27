/**
 * @covers CCLI-11
 *
 * Una CLI che esce PRIMA di leggere il prompt non deve portarsi dietro il
 * server.
 *
 * Il difetto, visto in CI (run 33030011608): `complete()` fa `write(prompt)` +
 * `end()` sullo stdin del figlio. Se il figlio e' gia' uscito, la pipe e'
 * chiusa e arriva EPIPE — ma NON dentro la write: arriva asincrono mentre lo
 * stream si chiude (`finishMaybe` → `destroy` → `end`). Nessun try/catch
 * attorno alla write puo' vederlo, e senza un ascoltatore su `stdin` Bun lo
 * tratta come eccezione non gestita e ABBATTE IL PROCESSO. In quel run il
 * server di test e' morto e ha lasciato ~200 prove a 0ms.
 *
 * Il test riproduce la sola condizione che conta — pipe chiusa sotto la
 * scrittura — in un processo figlio, perche' e' l'unico modo di distinguere
 * «gestito» da «il processo e' morto»: dentro il runner un'eccezione non
 * gestita verrebbe attribuita al test invece che al server.
 *
 * Controprova ESEGUITA: togliendo `proc.stdin.on("error")` da `complete()`,
 * questo figlio stampa «EPIPE» ed esce 1; con la cura esce 0 e pulito. Nota
 * che «VIVO» viene stampato in ENTRAMBI i casi — l'eccezione asincrona arriva
 * dopo — quindi la riga da sola non prova niente: cio' che distingue i due
 * mondi e' il CODICE DI USCITA, ed e' su quello che questo test insiste.
 */
import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("claude-code complete(): CLI che esce prima di leggere", () => {
  test("EPIPE sullo stdin non uccide il processo", () => {
    const dir = mkdtempSync(join(tmpdir(), "epipe-"));

    // Una CLI che esce SUBITO, senza toccare stdin: il caso reale di un
    // binario che crasha all'avvio o di un percorso sbagliato.
    const fakeCli = join(dir, "cli-che-esce-subito.sh");
    writeFileSync(fakeCli, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(fakeCli, 0o755);

    // Il prompt deve superare la capienza della pipe (64 KiB su Linux):
    // sotto quella soglia il kernel assorbe la scrittura nel buffer e
    // l'EPIPE non si presenta affatto. Con 1 MiB la scrittura arriva
    // davvero alla pipe chiusa.
    const driver = join(dir, "driver.ts");
    writeFileSync(driver, `
      import { ClaudeCodeProvider } from ${JSON.stringify(join(import.meta.dir, "claude-code.ts"))};
      const provider = new ClaudeCodeProvider({});
      await provider.complete([{ role: "user", content: "x".repeat(1024 * 1024) }]);
      // Se siamo qui, l'EPIPE e' stato gestito e il processo e' ancora vivo.
      console.log("VIVO");
    `);

    const run = spawnSync(process.execPath, [driver], {
      env: { ...process.env, TOPICS_CLAUDE_CLI_PATH: fakeCli },
      encoding: "utf8",
      timeout: 30_000,
    });

    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    expect(output).not.toContain("EPIPE");
    expect(run.stdout ?? "").toContain("VIVO");
    expect(run.status).toBe(0);
  }, 40_000);
});
