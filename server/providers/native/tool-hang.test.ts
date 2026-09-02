/**
 * UN COMANDO FINITO DEVE RISPONDERE, ANCHE SE QUALCUNO GLI TIENE APERTA LA PIPE.
 *
 * Il 02/09/2026, `topic:6b9605e5` e `topic:ada7e7db` sono rimasti su
 * `bash:running` per ore. Il comando era della forma
 * `cd x && nohup <demone> > /tmp/log 2>&1 &` seguito da una `curl` di prova: la
 * redirezione vale per il demone, non per la sottoshell che bash forka per
 * mandarlo in fondo, e quella sottoshell (pid 30236, riadottata da init) teneva
 * aperti stdout e stderr del server per tre ore e mezza. `runCommand`
 * aspettava `close`, che arriva solo a pipe chiuse: la promessa del tool non si
 * e' mai risolta, il ciclo dell'agente e' rimasto dentro la sua await, e i tre
 * guardiani sopra — `isTurnProcessAlive`, `toolRunning`, il cap del riavvio —
 * hanno letto quell'attesa come lavoro in corso. Due chat ferme in caricamento
 * e il riavvio automatico bloccato da loro.
 *
 * @covers RT-01
 */
import { describe, expect, test } from "bun:test";
import { executeTool } from "./tools";

describe("runCommand risponde quando il comando esce", () => {
  test("un figlio in background che eredita la pipe non blocca la risposta", async () => {
    const partito = Date.now();
    // `sleep 20 &` eredita il nostro stdout e non lo chiude: bash esce subito,
    // `close` arriverebbe fra venti secondi. Prima del fix questa await
    // scadeva; ora la risposta arriva con l'uscita del capofila.
    const out = await executeTool(
      "bash",
      { command: "sleep 20 & echo via" },
      { workspace: process.cwd() },
    );
    expect(Date.now() - partito).toBeLessThan(5000);
    expect(out.content).toContain("via");
    expect(out.isError).toBeUndefined();
  });

  test("il timeout risponde anche se non arriva nessun evento", async () => {
    const partito = Date.now();
    const out = await executeTool(
      "bash",
      { command: "sleep 30" },
      { workspace: process.cwd(), bashTimeoutMs: 300 },
    );
    // Il tetto e' 300ms + la grazia concessa al kill: molto sotto i 30s del
    // comando, che e' il punto.
    expect(Date.now() - partito).toBeLessThan(5000);
    expect(out.content).toContain("ucciso dopo 300ms");
  });

  test("l'output normale resta intero", async () => {
    const out = await executeTool(
      "bash",
      { command: "for i in 1 2 3; do echo riga$i; done" },
      { workspace: process.cwd() },
    );
    expect(out.content).toContain("riga1");
    expect(out.content).toContain("riga3");
  });
});
