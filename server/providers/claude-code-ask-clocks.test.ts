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
import { beginPermission, endPermission } from "../lib/permission-bridge";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls instead of guessing a delay: a loaded machine runs a 10 ms timer late. */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!cond() && Date.now() < until) await sleep(5);
}

function fakePP() {
  return {
    sessionKey: "",
    alive: true,
    inactivityTimer: null,
    lifetimeTimer: null as { clear: () => void } | null,
    heartbeatInterval: null,
    subAgentEmit: new Map(),
    streamHandler: null as unknown,
    lastEventAt: Date.now(),
    io: { writeStdin: () => {}, kill: () => {}, signal: () => {} },
    readline: { close() {} },
  };
}

/** Provider con il minimo cablato: interessa solo chi chiama `killProcess`. */
function setup(sessionKey: string) {
  const provider = new ClaudeCodeProvider({ type: "claude-code" });
  const p = provider as any;
  const pp = fakePP();
  pp.sessionKey = sessionKey;
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
 * THE LIFETIME CAP NEVER CUTS A TURN IN FLIGHT.
 *
 * On 2026-09-24 (chat 3019832f) the 2 h cap fired at 12:42 while the child was
 * streaming a turn: the CLI died mid-answer, and in broker mode nobody told the
 * waiting send. The cap is a wall clock on purpose (it recycles the child); what
 * was missing is the guard the idle reaper already has: a child with a stream
 * handler is busy, so the cap waits for the turn to end and fires on the first
 * tick after it.
 */
describe("lifetime cap and the turn in flight", () => {
  test("rearms while a turn is streaming, fires on the first tick after it ends", async () => {
    const sessionKey = "sess-life-turn";
    const { p, pp, killed } = setup(sessionKey);
    pp.streamHandler = {};
    // Every re-arm goes through `armLifetime` again: record its options, because
    // a re-arm with the whole cap would still pass on timing alone here, and in
    // production would recycle the child up to 2 h after the turn, not 60 s.
    const rearms: Array<{ ms?: number; rearmMs?: number }> = [];
    const arm = p.armLifetime.bind(p);
    p.armLifetime = (a: unknown, b: string, o: { ms?: number; rearmMs?: number }) => { rearms.push(o); return arm(a, b, o); };

    p.armLifetime(pp, sessionKey, { ms: 50, rearmMs: 10 });
    await sleep(150);

    expect(killed()).toBe(0);
    expect(p.processes.get(sessionKey)).toBe(pp);
    expect(rearms.length).toBeGreaterThan(1);
    expect(rearms.slice(1).every((o) => o.ms === 10)).toBe(true);

    pp.streamHandler = null;
    await waitFor(() => killed() > 0);
    pp.lifetimeTimer?.clear();

    expect(killed()).toBe(1);
    expect(p.processes.get(sessionKey)).toBeUndefined();
  });

  test("a send still waiting on the child holds the cap even with no handler", async () => {
    // The route can stop watching a turn (it unregisters its handler) while the
    // CLI is still working on it: the send is pending, and that is a turn too.
    const sessionKey = "sess-life-pending";
    const { p, pp, killed } = setup(sessionKey);
    (pp as any).pendingReject = () => {};

    p.armLifetime(pp, sessionKey, { ms: 20, rearmMs: 10 });
    await sleep(100);
    expect(killed()).toBe(0);

    (pp as any).pendingReject = null;
    await waitFor(() => killed() > 0);
    pp.lifetimeTimer?.clear();
    expect(killed()).toBe(1);
  });

  /**
   * A spontaneous turn the route has not adopted yet, or has declined, is the
   * child working too. Its lines leave `handleStreamEvent` early (buffered, or
   * dropped), and they used to leave before the event clock: a child idle for
   * over half an hour before the wake read as wedged, and the cap killed it
   * while it wrote. The lines go through the real `handleStreamEvent` here,
   * after a long idle: fixing `lastEventAt` by hand is what let the previous
   * version of this test pass by construction (adversarial review, PR #134).
   * Scale: 5 s of idle before the wake against a 1 s window, so only a missing
   * fix turns these red, not a machine that pauses for 200 ms.
   */
  for (const flags of [{ declinedTurn: true }, { wokenBuffer: [] as unknown[] }]) {
    const name = Object.keys(flags)[0];
    test(`a spontaneous turn that is writing (${name}) is not killed by the cap`, async () => {
      const sessionKey = `sess-life-${name}`;
      const { p, pp, killed } = setup(sessionKey);
      Object.assign(pp, flags);
      pp.lastEventAt = Date.now() - 5_000;

      let lines = 0;
      const pump = setInterval(() => {
        p.handleStreamEvent(pp, {
          type: "assistant",
          message: { id: `msg_${lines}`, role: "assistant", content: [{ type: "text", text: `working ${lines}` }] },
        });
        lines++;
      }, 5);
      p.armLifetime(pp, sessionKey, { ms: 20, rearmMs: 10, wedgedMs: 1_000 });
      await sleep(150);
      clearInterval(pump);
      pp.lifetimeTimer?.clear();

      expect(lines).toBeGreaterThan(10);
      expect(killed()).toBe(0);
    });
  }

  test("a turn silent past the watchdog window is still recycled", async () => {
    // A woken turn has no turn watchdog: if it wedges, this cap is the only
    // thing that ends it, as it was before the cap learned to wait.
    const sessionKey = "sess-life-wedged";
    const { p, pp, killed } = setup(sessionKey);
    pp.streamHandler = {};
    pp.lastEventAt = Date.now() - 1_000;

    p.armLifetime(pp, sessionKey, { ms: 20, rearmMs: 10, wedgedMs: 500 });
    await waitFor(() => killed() > 0);
    pp.lifetimeTimer?.clear();

    expect(killed()).toBe(1);
    expect(p.processes.get(sessionKey)).toBeUndefined();
  });

  /**
   * The person's time is not silence. While a permission prompt or a question
   * is open the cap re-arms (`isHumanHold`), but `lastEventAt` stays at the
   * `tool_use` that asked: once the person answers, the first tick found more
   * than the watchdog window of "silence" and killed the child while the
   * approved command ran, and a Bash that was approved prints nothing until it
   * ends (adversarial review, PR #134).
   */
  test("an approved permission after a long wait: the command it runs is not killed", async () => {
    const sessionKey = "sess-life-permission";
    const { p, pp, killed } = setup(sessionKey);
    pp.streamHandler = {};
    (pp as any).pendingReject = () => {};
    pp.lastEventAt = Date.now() - 5_000;
    beginPermission(sessionKey, "toolu_perm");

    p.armLifetime(pp, sessionKey, { ms: 20, rearmMs: 10, wedgedMs: 1_000 });
    await sleep(60);
    const duringHold = killed();

    endPermission(sessionKey, "toolu_perm");
    // The approved command runs without output.
    await sleep(50);
    const whileToolRuns = killed();
    pp.lifetimeTimer?.clear();

    expect(duringHold).toBe(0);
    expect(whileToolRuns).toBe(0);
  });

  test("a question just answered: the turn it resumes is not killed", async () => {
    const sessionKey = "sess-life-answered";
    KEYS.push(sessionKey);
    const { p, pp, killed } = setup(sessionKey);
    pp.streamHandler = {};
    (pp as any).pendingReject = () => {};
    pp.lastEventAt = Date.now() - 5_000;
    beginAsk(sessionKey);

    p.armLifetime(pp, sessionKey, { ms: 20, rearmMs: 10, wedgedMs: 1_000 });
    await sleep(60);
    expect(killed()).toBe(0);

    endAsk(sessionKey);
    // The CLI's tool_result arrives a moment after the answer.
    await sleep(25);
    pp.lastEventAt = Date.now();
    await sleep(40);
    pp.lifetimeTimer?.clear();

    expect(killed()).toBe(0);
  });

  test("a wedged spontaneous turn killed by the cap ends on its handler, as a watchdog stop", async () => {
    // Adopted, so it has a handler, but no send: nothing awaits a rejection,
    // and in broker mode no exit frame comes. The row stayed open until the
    // route's watchdog wrote «Response timed out» two minutes later.
    const sessionKey = "sess-life-wedged-woken";
    const provider = new ClaudeCodeProvider({ type: "claude-code" });
    const p = provider as any;
    const pp = fakePP();
    pp.sessionKey = sessionKey;
    p.processes.set(sessionKey, pp);
    const ends: unknown[] = [];
    pp.streamHandler = {
      onAborted: (m: { turnEnd?: unknown }) => ends.push(m?.turnEnd),
      onError: (e: string) => ends.push(`error:${e}`),
    };
    pp.lastEventAt = Date.now() - 1_000;

    p.armLifetime(pp, sessionKey, { ms: 20, rearmMs: 10, wedgedMs: 200 });
    await waitFor(() => ends.length > 0);

    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ end: "cancelled", cause: "watchdog" });
    expect(pp.streamHandler).toBeNull();
    expect(p.processes.get(sessionKey)).toBeUndefined();
  });

  test("an orphaned cap does not touch the process that took its key", async () => {
    const sessionKey = "sess-life-orphan";
    const { p, pp: ppA, killed } = setup(sessionKey);

    const deadline = p.armLifetime(ppA, sessionKey, { ms: 5, rearmMs: 5 });
    // Re-adoption: another `pp` takes the key (what `reattach` does). In broker
    // mode `killProcess` kills BY KEY, so an orphan would kill the successor.
    const ppB = fakePP();
    p.processes.set(sessionKey, ppB);

    await sleep(40);
    deadline.clear();

    expect(killed()).toBe(0);
    expect(p.processes.get(sessionKey)).toBe(ppB);
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

describe("a config change and the turn in flight", () => {
  test("refreshSessionConfig does not kill a child with a send still pending", async () => {
    // Same rule as the lifetime cap: a send waiting on the child is a turn in
    // flight even after the route released its handler. The change applies at
    // the next natural respawn instead.
    const sessionKey = "sess-config-pending";
    const { p, pp, killed } = setup(sessionKey);
    (pp as any).pendingReject = () => {};

    p.refreshSessionConfig(sessionKey);

    expect(killed()).toBe(0);
    expect(p.processes.get(sessionKey)).toBe(pp);

    (pp as any).pendingReject = null;
    p.refreshSessionConfig(sessionKey);
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
