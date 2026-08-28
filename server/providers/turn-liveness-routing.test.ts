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
  resolveSessionOwner,
  childAliveForSweep,
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

/**
 * THE SWEEPER USED THE WRONG PROBE, and the dispatcher did not.
 *
 * Measured on 2026-08-28 against a real turn (topic:0299ac2d, provider `topics`,
 * killed while it sat inside a three-minute bash call). `server.ts` had already
 * fixed the dispatcher with `resolveTurnAlive` and left the stale-stream sweeper,
 * ten lines further down, hardwired to `tryGetProvider("claude-code")`. For a
 * native session that provider answers `false` — "I looked and it is dead" — and
 * `staleStreamVerdict` discards anything that is not `true`, so the "rescue" and
 * "extend" branches were unreachable: three minutes of silence closed the turn,
 * alive or not.
 *
 * The signature was already in the production logs and nobody had read it: 64
 * finalizations, ZERO extensions, all 18 killed sessions on provider `topics`,
 * all 12 protected ones claude-code.
 * @covers KANBAN-10
 */
describe("the sweeper probe, by name", () => {
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "sweep-probe-"));
    initDatabase(tmpRoot);
    clearRegistry();
  });
  afterEach(() => {
    clearRegistry();
    try { closeDatabase(); } catch { /* already closed */ }
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* scratch */ }
  });

  test("IL CASO CHE HA UCCISO IL TURNO: il proprietario dice vivo, e la sonda lo riporta", async () => {
    // A NON-claude-code provider that really owns the session, like the native
    // one in the real case. claude-code is registered next to it, and it is
    // exactly the one that used to answer `false` for a session not its own.
    const jcode = registerProvider({
      type: "acp",
      name: "jcode",
      command: process.execPath,
      args: [join(import.meta.dir, "acp", "fake-agent.fixture.ts")],
      defaultWorkspace: tmpRoot,
    });
    registerProvider({ type: "claude-code" });
    await jcode.sendChat("topic:viva", "ciao", {
      onTextDelta: () => {},
      onToolStart: () => {},
      onToolResult: () => {},
      onDone: () => {},
      onError: () => {},
    });

    // This was `false` before, and with `false` staleStreamVerdict always finalizes.
    expect(childAliveForSweep("topic:viva")).toBe(true);
    // And the rescue finds the right owner, not claude-code.
    expect(resolveSessionOwner("topic:viva")).toBe(jcode as never);
  });

  test("un turno che NON e' di nessuno resta `undefined`, non `false`", () => {
    // The pure rule treats `undefined` as dead, and that is deliberate: a
    // sweeper that never finalizes would leave partial messages hanging forever.
    // The point is that it no longer arrives from a claude-code LIE.
    registerProvider({ type: "claude-code" });
    expect(childAliveForSweep("topic:di-nessuno")).toBeUndefined();
  });

  test("il soccorso va al proprietario, non a claude-code", () => {
    // `resyncStream` was hardwired to claude-code too: for somebody else's turn
    // it was a mute no-op, a recovery attempt that attempted nothing.
    registerProvider({ type: "claude-code" });
    expect(resolveSessionOwner("topic:di-nessuno")).toBeNull();
  });
});
