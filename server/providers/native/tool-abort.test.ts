/**
 * UN TOOL LUNGO NON PUÒ SOPRAVVIVERE ALLO SPEGNIMENTO CHE LO STA UCCIDENDO.
 *
 * Il 20/08, topic:9f9e9629: l'agente aveva lanciato un `bash` con `sleep 100`
 * dentro. Un salvataggio in `server/` ha fatto scattare fswatch, il server ha
 * atteso il suo cap e poi ha mandato SIGTERM. `stop()` del runtime nativo ha
 * chiamato `abort("server-shutdown")` — ma il ciclo guarda il segnale SOLO in
 * cima al giro, e in quel momento era fermo dentro `await executeTool`. Il
 * segnale non aveva nessuno che lo ascoltasse: il processo è uscito prima che
 * il comando finisse, e il cartello che spiegava la caduta non è mai stato
 * scritto. In chat: risposta troncata a metà frase, zero spiegazioni.
 *
 * Il cartello ESISTEVA già (`cancelled-notice.ts`, commit delle 20:00 dello
 * stesso giorno) e i suoi test erano verdi. Guidavano `finalizeStream`, cioè
 * partivano DOPO l'`onAborted` che qui non arrivava mai.
 *
 * Questi test partono da dove parte il guasto: un tool in volo.
  * @covers RT-01
 */
import { describe, expect, test } from "bun:test";
import { executeTool } from "./tools";

describe("un tool in volo sente l'abort", () => {
  test("bash lungo: l'abort lo chiude subito, non dopo il timeout", async () => {
    const ac = new AbortController();
    const partito = Date.now();
    // 30 secondi di comando, annullato dopo 100ms: se il segnale non arriva
    // fin dentro il figlio, questa `await` resta appesa e il test scade.
    setTimeout(() => ac.abort("server-shutdown"), 100);
    const out = await executeTool(
      "bash",
      { command: "sleep 30" },
      { workspace: process.cwd(), signal: ac.signal },
    );
    const durata = Date.now() - partito;
    expect(durata).toBeLessThan(3000);
    expect(out.isError).toBe(true);
    // Il testo dice PERCHÉ: un `[exit null]` nudo manda a cercare un guasto
    // del comando, che non c'è stato.
    expect(out.content).toContain("interrotto");
  });

  test("senza segnale si comporta esattamente come prima", async () => {
    const out = await executeTool("bash", { command: "echo ciao" }, { workspace: process.cwd() });
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain("ciao");
  });

  test("un segnale già annullato non fa nemmeno partire il comando", async () => {
    const ac = new AbortController();
    ac.abort("server-shutdown");
    const partito = Date.now();
    const out = await executeTool(
      "bash",
      { command: "sleep 30" },
      { workspace: process.cwd(), signal: ac.signal },
    );
    expect(Date.now() - partito).toBeLessThan(1000);
    expect(out.isError).toBe(true);
  });
});
