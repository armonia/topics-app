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
  AskWaitError,
  bufferedAnswerFits,
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

  test("beginAsk opens once and keeps the age on the question, not on the leg", () => {
    // Later legs are no-ops: the age counts from when the question opened.
    const k = key();
    const t0 = 1_000_000;
    beginAsk(k, t0);
    beginAsk(k, t0 + 30_000);
    expect(pendingAskAgeMs(k, t0 + 60_000)).toBe(60_000);
    endAsk(k);
    // Closed and reopened: a new question, a new age.
    beginAsk(k, t0 + 60_000);
    expect(pendingAskAgeMs(k, t0 + 60_000)).toBe(0);
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

  test("an answer no leg ever claims is handed on, not dropped", async () => {
    // The 30-second buffer used to expire in silence: the person had answered,
    // the asker was gone, and the answer vanished.
    const k = key();
    const handed: Array<Record<string, string>> = [];
    deliverAnswer(k, { Q: "late" }, { bufferTtlMs: 5, onUnclaimed: (a) => handed.push(a) });
    const until = Date.now() + 2000;
    while (handed.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
    expect(handed).toEqual([{ Q: "late" }]);
  });

  test("a claimed or cancelled answer is not handed on", async () => {
    const k = key();
    const handed: unknown[] = [];
    deliverAnswer(k, { Q: "claimed" }, { bufferTtlMs: 20, onUnclaimed: (a) => handed.push(a) });
    await expect(waitForAnswer(k, { timeoutMs: 1000 })).resolves.toEqual({ Q: "claimed" });
    const k2 = key();
    deliverAnswer(k2, { Q: "dropped" }, { bufferTtlMs: 20, onUnclaimed: (a) => handed.push(a) });
    cancelAsk(k2, "stop");
    await new Promise((r) => setTimeout(r, 60));
    expect(handed).toEqual([]);
  });

  test("deliverAnswer with no waiter always returns true (buffered)", () => {
    const k = key();
    expect(deliverAnswer(k, { Q: "A" })).toBe(true);
    cancelAsk(k); // cleanup
  });
});

describe("ask-user-bridge — quanto aspetta", () => {
  test("a question never expires: open for 25 hours, a week, it is still open", () => {
    // The TTL was 10 minutes, then 90, then 24 hours: each time a person who
    // came back later found a panel closed by nobody. A question ends for a
    // REASON (answer, Stop, a new message), never for time (29/09).
    const k = key();
    const t0 = 5_000_000;
    const h = 60 * 60 * 1000;
    beginAsk(k, t0);
    beginAsk(k, t0 + 25 * h);
    beginAsk(k, t0 + 7 * 24 * h);
    expect(hasPendingAsk(k)).toBe(true);
    expect(pendingAskVerdict({ askAgeMs: 7 * 24 * h, childAlive: true })).toBe("defer");
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
    // morto non arriva più nessuna gamba di poll: nothing else would notice.
    expect(pendingAskVerdict({ askAgeMs: 1_000, childAlive: false })).toBe("close-ask");
  });

  test("un provider che non sa rispondere vale VIVO: si sbaglia dalla parte di non uccidere", () => {
    expect(pendingAskVerdict({ askAgeMs: 1_000, childAlive: undefined })).toBe("defer");
  });

  test("age is never a reason: 25 hours on a live child still defers", () => {
    expect(pendingAskVerdict({ askAgeMs: 25 * 60 * 60 * 1000, childAlive: true })).toBe("defer");
  });

  test("pendingAskAgeMs misura la domanda, non la gamba: le gambe successive non la ringiovaniscono", () => {
    const k = key();
    const t0 = 9_000_000;
    expect(pendingAskAgeMs(k, t0)).toBeNull();
    beginAsk(k, t0);
    expect(pendingAskAgeMs(k, t0 + 60_000)).toBe(60_000);
    beginAsk(k, t0 + 60_000); // una gamba più tardi
    expect(pendingAskAgeMs(k, t0 + 120_000)).toBe(120_000);
    endAsk(k);
    expect(pendingAskAgeMs(k, t0 + 120_000)).toBeNull();
  });
});

describe("ask-user-bridge — a buffered answer belongs to its question", () => {
  test("bufferedAnswerFits: by panel when both name one, by texts otherwise, anything for an unbound answer", () => {
    expect(bufferedAnswerFits({}, { questions: ["B?"] })).toBe(true);
    expect(bufferedAnswerFits({ toolCallId: "a" }, { toolCallId: "a" })).toBe(true);
    expect(bufferedAnswerFits({ toolCallId: "a" }, { toolCallId: "b" })).toBe(false);
    expect(bufferedAnswerFits({ toolCallId: "a", questions: ["A?"] }, { questions: ["A?"] })).toBe(true);
    expect(bufferedAnswerFits({ toolCallId: "a", questions: ["A?"] }, { questions: ["B?"] })).toBe(false);
    expect(bufferedAnswerFits({ toolCallId: "a", questions: ["A?"] }, {})).toBe(true);
  });

  test("the leg of another question does not collect it; the leg of its own does", async () => {
    const k = key();
    deliverAnswer(k, { "A?": "yes" }, { toolCallId: "a", questions: ["A?"] });
    await expect(waitForAnswer(k, { timeoutMs: 20, questions: ["B?"] })).rejects.toMatchObject({ code: "timeout" });
    await expect(waitForAnswer(k, { timeoutMs: 20, questions: ["A?"] })).resolves.toEqual({ "A?": "yes" });
  });

  test("an answer displaced by an answer to another question is handed on, not overwritten", () => {
    const k = key();
    const handedOn: Array<Record<string, string>> = [];
    deliverAnswer(k, { "A?": "yes" }, { toolCallId: "a", questions: ["A?"], onUnclaimed: (x) => handedOn.push(x) });
    deliverAnswer(k, { "B?": "no" }, { toolCallId: "b", questions: ["B?"] });
    expect(handedOn).toEqual([{ "A?": "yes" }]);
    cancelAsk(k);
  });
});
