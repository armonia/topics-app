/**
 * La rete di liveness quando l'agente NON è claude-code.
 *
 * Il patto del dispatcher, scritto nei suoi stessi commenti: `isTurnAlive`
 * risponde `true` (vivo), `false` (morto) o `null` (non lo so), e l'ignoranza
 * non deve MAI leggersi come morte — un turno sepolto per sbaglio è lavoro vero
 * buttato, ed è già successo (fix 1790f859).
 *
 * Il buco che questo file copre. La sonda in `server.ts` è cablata su
 * `claude-code`: chiede a QUEL provider se il processo di una sessione è vivo.
 * `isTurnProcessAlive` guarda la sua mappa `processes`, e una sessione servita
 * da un altro provider lì dentro non c'è mai stata — quindi la risposta è
 * `false`, cioè «morto», invece di `null`, cioè «non è roba mia». Sono due
 * frasi diverse e il dispatcher agisce solo sulla prima: dopo due giri di
 * sweep, seppellisce.
 *
 * Prima del 2026-08-16 non si vedeva, perché gli agenti dispacciati erano tutti
 * claude-code. Col runtime `jcode` di default ogni sessione dispacciata è di un
 * altro provider, quindi il ramo passa da «impossibile» a «sempre».
 * @covers KANBAN-10
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDatabase, closeDatabase } from "../db";
import {
  registerProvider,
  removeProvider,
  listProviders,
  resolveTurnAlive,
} from "./index";

let tmpRoot: string;

function clearRegistry() {
  for (const { name } of listProviders()) removeProvider(name);
}

describe("chi è vivo, e chi non lo sa", () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "liveness-"));
    initDatabase(tmpRoot);
    clearRegistry();
  });
  afterEach(() => {
    clearRegistry();
    try { closeDatabase(); } catch { /* già chiusa */ }
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* scratch */ }
  });

  test("nessun provider che sappia rispondere → `null`, non `false`", () => {
    expect(resolveTurnAlive("topic:ignoto")).toBeNull();
  });

  // IL TEST CHE CONTA. La sessione è di un provider ACP, e claude-code è pure
  // registrato: la domanda «è vivo?» non deve finire a claude-code, che di
  // quella sessione non sa niente e risponderebbe «morto».
  test("sessione di un provider ACP: claude-code non risponde per lui", () => {
    registerProvider({ type: "claude-code" });
    registerProvider({
      type: "acp",
      name: "jcode",
      command: process.execPath,
      args: ["--version"],
    });
    // Nessun turno in volo su quella sessione: la risposta onesta è «non so»,
    // perché il provider ACP non tiene un processo per sessione da sondare.
    // `false` qui vorrebbe dire «l'ho guardato ed è morto», che è una bugia.
    expect(resolveTurnAlive("topic:su-jcode")).toBeNull();
  });

  test("con il solo claude-code registrato, la sua risposta vale ancora", () => {
    // La rete non deve INDEBOLIRSI per chi era già coperto: se l'unico provider
    // capace di rispondere è claude-code e la sessione non è sua, resta `null`
    // — ma la strada per una risposta vera è intatta (vedi il test sopra, dove
    // il provider giusto verrebbe interrogato se avesse la sonda).
    registerProvider({ type: "claude-code" });
    expect(resolveTurnAlive("topic:mai-vista")).toBeNull();
  });

  /**
   * La prova che il giro si chiude: una sessione che il provider ACP possiede
   * DAVVERO riceve la risposta di quel provider, non un `null` di comodo.
   *
   * Senza questo caso i tre test sopra sarebbero soddisfatti anche da una
   * funzione che risponde `null` sempre — cioè da una rete spenta, che non
   * seppellisce niente perché non sa niente. Qui l'agente è un processo vero
   * (`bun --version`), quindi la sessione entra nella mappa del provider e la
   * domanda trova un padrone.
   */
  test("sessione posseduta dall'ACP: risponde LUI, e la rete resta accesa", async () => {
    const jcode = registerProvider({
      type: "acp",
      name: "jcode",
      command: process.execPath,
      args: [join(import.meta.dir, "acp", "fake-agent.fixture.ts")],
      defaultWorkspace: tmpRoot,
    });
    registerProvider({ type: "claude-code" });

    // Un turno vero apre la sessione lato provider.
    await jcode.sendChat("topic:mia", "ciao", {
      onTextDelta: () => {},
      onToolStart: () => {},
      onToolResult: () => {},
      onDone: () => {},
      onError: () => {},
    });

    // Ora la sessione ha un padrone, e il padrone sa rispondere: il processo
    // dell'agente è vivo, quindi `true`. Un `null` qui vorrebbe dire rete
    // spenta; un `false` vorrebbe dire che ha risposto claude-code.
    expect(resolveTurnAlive("topic:mia")).toBe(true);

    // E una sessione che NON è di nessuno resta `null` anche adesso: avere un
    // padrone per una sessione non autorizza a parlare per le altre.
    expect(resolveTurnAlive("topic:di-nessuno")).toBeNull();
  });
});
