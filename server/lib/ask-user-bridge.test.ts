import { describe, expect, test } from "bun:test";
import {
  waitForAnswer,
  deliverAnswer,
  hasPendingAsk,
  cancelAsk,
  beginAsk,
  endAsk,
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
  test("il TTL della domanda è tarato su un umano che si alza dalla scrivania", () => {
    // 90 min di default: sopra la finestra di silenzio del watchdog (30 min, che
    // ora esenta le domande in volo) e SOTTO il cap di vita del child (2 h) —
    // oltre quello il processo viene ucciso e l'attesa finirebbe su un morto
    // invece che su questa cancellazione pulita.
    const k = key();
    const t0 = 5_000_000;
    expect(beginAsk(k, undefined, t0)).toBe(true);
    expect(beginAsk(k, undefined, t0 + 89 * 60 * 1000)).toBe(true);
    expect(beginAsk(k, undefined, t0 + 91 * 60 * 1000)).toBe(false);
    endAsk(k);
  });
});
