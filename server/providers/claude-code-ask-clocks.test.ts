/**
 * UNA DOMANDA A SCHERMO NON SCADE: gli orologi che la uccidevano.
 *
 * Il provider ne aveva quattro sul percorso di un `ask_user_question`, e due
 * non sapevano che dall'altra parte c'è una persona:
 *
 *  - il TETTO DI VITA del figlio (`MAX_LIFETIME_MS`, 2 h). Il più letale:
 *    ammazzava il figlio SOTTO un pannello ancora cliccabile, e siccome era il
 *    tetto più basso costringeva la domanda stessa a scadere prima di lui
 *    (`ASK_TTL_MS` era 90 minuti «perché doveva stare sotto le due ore»).
 *  - il REAPER DELLA POOL (`INACTIVITY_TIMEOUT_MS`, 15 min). Un turno
 *    parcheggiato non ne arma nessuno — ma `reattach` sostituiva la voce nella
 *    mappa lasciando armato il timer della vecchia, e in modalità broker
 *    `killProcess` uccide il figlio PER CHIAVE: l'orfano ammazzava il figlio di
 *    chi aveva preso il suo posto.
 *
 * Più la perdita opposta: `/clear` uccideva il figlio SENZA chiudere l'ask, e
 * una voce rimasta in `activeAsks` fa giurare a `hasPendingAsk` che una domanda
 * sia a schermo — disarmando, per il turno dopo, proprio i guardiani qui sopra.
 *
 * Qui si prova il CABLAGGIO, non la regola: la regola sta in
 * `turn-deadline.test.ts`, ma quella che uccideva era la riga che non la usava.
 * I metodi accettano i millisecondi come override apposta — due ore, e nemmeno
 * quindici minuti, non si aspettano in un test.
  * @covers CCLI-02
 */
import { describe, test, expect, afterEach } from "bun:test";
import { ClaudeCodeProvider } from "./claude-code";
import { beginAsk, endAsk, hasPendingAsk } from "../lib/ask-user-bridge";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakePP() {
  return {
    alive: true,
    inactivityTimer: null,
    lifetimeTimer: null,
    heartbeatInterval: null,
    subAgentEmit: new Map(),
    io: { writeStdin: () => {}, kill: () => {}, signal: () => {} },
    readline: { close() {} },
  };
}

/** Provider con il minimo cablato: interessa solo chi chiama `killProcess`. */
function setup(sessionKey: string) {
  const provider = new ClaudeCodeProvider({ type: "claude-code" });
  const p = provider as any;
  const pp = fakePP();
  p.processes.set(sessionKey, pp);
  let killed = 0;
  p.killProcess = () => { killed++; };
  p.stopHeartbeat = () => {};
  return { provider, p, pp, killed: () => killed };
}

const KEYS: string[] = [];
afterEach(() => {
  for (const k of KEYS.splice(0)) endAsk(k);
});

describe("tetto di vita del figlio CLI", () => {
  test("senza domande a schermo scatta come sempre", async () => {
    const sessionKey = "sess-life-a";
    const { p, pp, killed } = setup(sessionKey);

    const deadline = p.armLifetime(pp, sessionKey, { ms: 5, rearmMs: 5 });
    await sleep(40);
    deadline.clear();

    expect(killed()).toBe(1);
    // …e il processo esce dalla mappa, come faceva il `setTimeout` di prima.
    expect(p.processes.get(sessionKey)).toBeUndefined();
  });

  test("con una domanda a schermo si riarma invece di uccidere", async () => {
    const sessionKey = "sess-life-b";
    KEYS.push(sessionKey);
    const { p, pp, killed } = setup(sessionKey);
    beginAsk(sessionKey);

    const deadline = p.armLifetime(pp, sessionKey, { ms: 5, rearmMs: 5 });
    // Molti giri di riarmo: con il vecchio `setTimeout` nudo sarebbe già morto
    // al primo.
    await sleep(60);

    expect(killed()).toBe(0);
    expect(p.processes.get(sessionKey)).toBe(pp);

    // Risposta data (o turno interrotto): il primo tick utile trova la palla
    // tornata all'agente e il tetto torna a mordere.
    endAsk(sessionKey);
    await sleep(40);
    deadline.clear();

    expect(killed()).toBe(1);
  });
});

/**
 * L'altro orologio sul percorso di una domanda, e quello che mordeva PRIMA di
 * tutti: il reaper della pool a 15 minuti. Un turno parcheggiato su una domanda
 * non ne arma nessuno (la `finally` che lo arma non è ancora passata), ma
 * `reattach` — che il dispatcher chiama ogni 10 s sui task orfani — sostituiva
 * la voce nella mappa lasciando ARMATO il timer di quella vecchia. In modalità
 * broker `killProcess` uccide il figlio PER CHIAVE: l'orfano ammazzava quindi il
 * figlio del `pp` appena adottato, e la `delete` sfrattava lui. Da lì il setaccio
 * legge «figlio morto» e chiude la domanda a schermo.
 */
describe("reaper d'inattività", () => {
  test("un timer ORFANO non tocca il processo che ha preso il suo posto", async () => {
    const sessionKey = "sess-inact-orphan";
    const { p, pp: ppA, killed } = setup(sessionKey);

    p.resetInactivityTimer(sessionKey, ppA, { ms: 5 });
    // Riadozione: un altro `pp` prende la chiave (è ciò che fa `reattach`).
    const ppB = fakePP();
    p.processes.set(sessionKey, ppB);

    await sleep(40);

    expect(killed()).toBe(0);
    expect(p.processes.get(sessionKey)).toBe(ppB);
    expect(ppA.inactivityTimer).toBeNull();
  });

  test("non miete un processo fermo su una domanda a schermo", async () => {
    const sessionKey = "sess-inact-ask";
    KEYS.push(sessionKey);
    const { p, pp, killed } = setup(sessionKey);
    beginAsk(sessionKey);

    p.resetInactivityTimer(sessionKey, pp, { ms: 5 });
    await sleep(60);
    expect(killed()).toBe(0);

    endAsk(sessionKey);
    await sleep(40);
    expect(killed()).toBe(1);
  });
});

describe("/clear non lascia una domanda fantasma dietro di sé", () => {
  test("resetSession chiude l'ask, o `hasPendingAsk` disarma i guardiani del turno dopo", async () => {
    const sessionKey = "sess-clear-ask";
    KEYS.push(sessionKey);
    const { provider, p } = setup(sessionKey);
    beginAsk(sessionKey);
    expect(hasPendingAsk(sessionKey)).toBe(true);

    await provider.resetSession(sessionKey);

    expect(hasPendingAsk(sessionKey)).toBe(false);
    expect(p.processes.get(sessionKey)).toBeUndefined();
  });
});
