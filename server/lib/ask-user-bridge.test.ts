/**
 * @covers ASK-02
 */
import { describe, expect, test } from "bun:test";
import {
  waitForAnswer,
  deliverAnswer,
  hasPendingAsk,
  cancelAsk,
  beginAsk,
  endAsk,
  pendingAskAgeMs,
  pendingAskVerdict,
  ASK_TTL_MS,
  AskWaitError,
} from "./ask-user-bridge";

// Each test uses a UNIQUE sessionKey so the module-level maps don't bleed
// between cases (the registry is a process-wide singleton by design — one
// blocked ask per live session).
let n = 0;
const key = () => `sess-${++n}-${"x".repeat(3)}`;

describe("ask-user-bridge — happy rendez-vous", () => {
  test("deliverAnswer resolves a waiting handler with the exact answers", async () => {
    const k = key();
    const answers = { Auth: "OAuth", Theme: "Dark" };
    beginAsk(k);
    const p = waitForAnswer(k, { timeoutMs: 5000 });
    expect(hasPendingAsk(k)).toBe(true);
    const delivered = deliverAnswer(k, answers);
    expect(delivered).toBe(true);
    await expect(p).resolves.toEqual(answers);
    // Answering closes the ask: no panel is on screen any more.
    expect(hasPendingAsk(k)).toBe(false);
  });

  test("answer that BEATS the waiter is buffered and picked up on register", async () => {
    const k = key();
    // Human answer lands before the bridge handler registers its next leg.
    const delivered = deliverAnswer(k, { Q: "A" });
    expect(delivered).toBe(true);
    // The ask is closed, so nothing is "on screen"...
    expect(hasPendingAsk(k)).toBe(false);
    // ...but the answer is still claimable by the leg that was in flight.
    await expect(waitForAnswer(k, { timeoutMs: 5000 })).resolves.toEqual({ Q: "A" });
  });
});

describe("ask-user-bridge — poll legs", () => {
  test("una gamba scaduta è un 'timeout', non una cancellazione", async () => {
    // Il route distingue i due casi sul `code`: `timeout` → {pending:true} e il
    // bridge ritorna subito; qualunque altro codice chiude la domanda.
    const k = key();
    beginAsk(k);
    const err = await waitForAnswer(k, { timeoutMs: 10 }).catch((e) => e);
    expect(err).toBeInstanceOf(AskWaitError);
    expect((err as AskWaitError).code).toBe("timeout");
    // La GAMBA è finita, ma la DOMANDA no: il pannello è ancora a schermo.
    expect(hasPendingAsk(k)).toBe(true);
    endAsk(k);
  });

  test("beginAsk apre una volta sola e tiene il clock sulla domanda, non sulla gamba", () => {
    // Se ogni gamba riaprisse la domanda, un poll ogni 25s la terrebbe viva per
    // sempre e il TTL non scadrebbe mai.
    const k = key();
    const t0 = 1_000_000;
    expect(beginAsk(k, 60_000, t0)).toBe(true);
    expect(beginAsk(k, 60_000, t0 + 30_000)).toBe(true);   // dentro il TTL
    expect(beginAsk(k, 60_000, t0 + 59_999)).toBe(true);
    expect(beginAsk(k, 60_000, t0 + 60_000)).toBe(false);  // scaduta
    endAsk(k);
    // Chiusa e riaperta: il clock riparte.
    expect(beginAsk(k, 60_000, t0 + 60_000)).toBe(true);
    endAsk(k);
  });

  test("hasPendingAsk resta vero nel buco fra due gambe", async () => {
    // Il caso che rompeva tutto: fra una gamba e l'altra non c'è nessun waiter
    // registrato. Se `hasPendingAsk` guardasse i waiter, in quel millisecondo il
    // watchdog vedrebbe un turno "muto" e la risposta dell'umano finirebbe sullo
    // stdin invece che sul bridge.
    const k = key();
    beginAsk(k);
    await waitForAnswer(k, { timeoutMs: 5 }).catch(() => {});
    expect(hasPendingAsk(k)).toBe(true); // nessun waiter, domanda viva
    endAsk(k);
    expect(hasPendingAsk(k)).toBe(false);
  });
});

describe("ask-user-bridge — lifecycle edges", () => {
  test("a second ask supersedes the first (stale waiter rejected)", async () => {
    const k = key();
    const first = waitForAnswer(k, { timeoutMs: 5000 });
    const second = waitForAnswer(k, { timeoutMs: 5000 });
    await expect(first).rejects.toThrow(/superseded/i);
    // The newer waiter is the live one.
    deliverAnswer(k, { Q: "B" });
    await expect(second).resolves.toEqual({ Q: "B" });
  });

  test("cancelAsk rejects a blocked handler with the given reason", async () => {
    const k = key();
    beginAsk(k);
    const p = waitForAnswer(k, { timeoutMs: 5000 });
    cancelAsk(k, "turn aborted");
    const err = await p.catch((e) => e);
    expect((err as AskWaitError).code).toBe("cancelled");
    expect((err as AskWaitError).message).toMatch(/turn aborted/i);
    expect(hasPendingAsk(k)).toBe(false);
  });

  test("cancelAsk also drops a buffered-but-unclaimed answer", async () => {
    const k = key();
    deliverAnswer(k, { Q: "stale" });
    cancelAsk(k, "torn down");
    // Buffer cleared: a later waiter must NOT resolve from the dropped answer;
    // its leg expires instead.
    await expect(waitForAnswer(k, { timeoutMs: 10 })).rejects.toThrow(/poll leg expired/i);
  });

  test("deliverAnswer with no waiter always returns true (buffered)", () => {
    const k = key();
    expect(deliverAnswer(k, { Q: "A" })).toBe(true);
    cancelAsk(k); // cleanup
  });
});

describe("ask-user-bridge — quanto aspetta", () => {
  test("una domanda non scade nell'arco di una giornata di lavoro", () => {
    // Il TTL è stato 10 minuti (morta prima che si tornasse da pranzo) e poi 90
    // — non perché un'ora e mezza volesse dire qualcosa, ma perché doveva stare
    // sotto il tetto di vita del figlio (2 h). Adesso quel tetto si riarma
    // finché un pannello è a schermo (`armLifetime`, claude-code.ts), quindi il
    // TTL non è più costretto: chiude una domanda un MOTIVO — risposta,
    // interruzione, o il figlio morto sotto il pannello — non l'orologio.
    // Quello che resta è solo un fondo contro le perdite.
    const k = key();
    const t0 = 5_000_000;
    const h = 60 * 60 * 1000;
    expect(beginAsk(k, undefined, t0)).toBe(true);
    // Le tre ore che uccidevano: chi esce alle 18 e risponde alle 21.
    expect(beginAsk(k, undefined, t0 + 3 * h)).toBe(true);
    // La notte intera.
    expect(beginAsk(k, undefined, t0 + 16 * h)).toBe(true);
    // Il fondo c'è ancora: una voce persa non tiene in piedi per sempre le
    // esenzioni che si appoggiano a `hasPendingAsk`.
    expect(beginAsk(k, undefined, t0 + 25 * h)).toBe(false);
    endAsk(k);
  });

  test("il figlio morto sotto il pannello chiude la domanda SUBITO, senza aspettare il fondo", () => {
    // È questa — non il tempo — la regola che impedisce a un `defer` di essere
    // eterno. Vale a qualunque età della domanda.
    expect(pendingAskVerdict({ askAgeMs: 5 * 60 * 60 * 1000, childAlive: false })).toBe("close-ask");
    expect(pendingAskVerdict({ askAgeMs: 5 * 60 * 60 * 1000, childAlive: true })).toBe("defer");
  });
});

describe("ask-user-bridge — il turno parcheggiato non è un turno morto", () => {
  /**
   * La regressione vera, misurata su `topic:ed2070df`: la domanda è comparsa,
   * l'umano non ha cliccato, e TRE MINUTI dopo lo sweeper degli stream fermi
   * (server.ts, `STALE_STREAM_TIMEOUT_MS`) ha chiuso il turno con «nessuna
   * attività per 3 minuti». Il watchdog del provider (30 min) aveva già la sua
   * esenzione per le domande in volo; lo sweeper no — e lui scatta dieci volte
   * prima. Risultato a schermo: un pannello ancora cliccabile, con 22 minuti
   * sul cronometro, accanto a un bottone Retry.
   *
   * `pendingAskVerdict` è quella regola, isolata: silenzio LEGITTIMO finché la
   * domanda è viva e il figlio pure, e non un secondo di più.
   */
  test("una domanda giovane con il figlio vivo rimanda l'orologio, non uccide il turno", () => {
    expect(pendingAskVerdict({ askAgeMs: 3 * 60 * 1000, childAlive: true })).toBe("defer");
    // 22 minuti — il caso della schermata — sono ancora attesa legittima.
    expect(pendingAskVerdict({ askAgeMs: 22 * 60 * 1000, childAlive: true })).toBe("defer");
  });

  test("senza domanda in ballo lo sweeper resta padrone a casa sua", () => {
    expect(pendingAskVerdict({ askAgeMs: null, childAlive: true })).toBe("none");
    expect(pendingAskVerdict({ askAgeMs: null, childAlive: false })).toBe("none");
  });

  test("se il figlio muore sotto il pannello la domanda si chiude: nessuno la onorerà", () => {
    // È il ramo che impedisce all'esenzione di essere eterna. Con il figlio
    // morto non arriva più nessuna gamba di poll, quindi il TTL — che vive
    // sulle gambe — non scadrebbe mai da solo.
    expect(pendingAskVerdict({ askAgeMs: 1_000, childAlive: false })).toBe("close-ask");
  });

  test("un provider che non sa rispondere vale VIVO: si sbaglia dalla parte di non uccidere", () => {
    expect(pendingAskVerdict({ askAgeMs: 1_000, childAlive: undefined })).toBe("defer");
  });

  test("oltre il TTL la domanda si chiude anche con il figlio vivo", () => {
    expect(pendingAskVerdict({ askAgeMs: ASK_TTL_MS - 1, childAlive: true })).toBe("defer");
    expect(pendingAskVerdict({ askAgeMs: ASK_TTL_MS, childAlive: true })).toBe("close-ask");
  });

  test("pendingAskAgeMs misura la domanda, non la gamba: le gambe successive non la ringiovaniscono", () => {
    const k = key();
    const t0 = 9_000_000;
    expect(pendingAskAgeMs(k, t0)).toBeNull();
    beginAsk(k, undefined, t0);
    expect(pendingAskAgeMs(k, t0 + 60_000)).toBe(60_000);
    beginAsk(k, undefined, t0 + 60_000); // una gamba più tardi
    expect(pendingAskAgeMs(k, t0 + 120_000)).toBe(120_000);
    endAsk(k);
    expect(pendingAskAgeMs(k, t0 + 120_000)).toBeNull();
  });
});
