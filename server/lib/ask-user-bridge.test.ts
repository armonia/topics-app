import { describe, expect, test } from "bun:test";
import {
  waitForAnswer,
  deliverAnswer,
  hasPendingAsk,
  cancelAsk,
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
    const p = waitForAnswer(k, { timeoutMs: 5000 });
    expect(hasPendingAsk(k)).toBe(true);
    const delivered = deliverAnswer(k, answers);
    expect(delivered).toBe(true);
    await expect(p).resolves.toEqual(answers);
    // Waiter is consumed once resolved.
    expect(hasPendingAsk(k)).toBe(false);
  });

  test("answer that BEATS the waiter is buffered and picked up on register", async () => {
    const k = key();
    // Human answer lands before the bridge handler registers its waiter.
    const delivered = deliverAnswer(k, { Q: "A" });
    expect(delivered).toBe(true);
    // No waiter yet, so nothing is "pending".
    expect(hasPendingAsk(k)).toBe(false);
    // The bridge handler now registers — the buffered answer resolves it
    // immediately, no second delivery needed.
    await expect(waitForAnswer(k, { timeoutMs: 5000 })).resolves.toEqual({ Q: "A" });
  });
});

describe("ask-user-bridge — lifecycle edges", () => {
  test("timeout rejects the waiter and clears the pending flag", async () => {
    const k = key();
    const p = waitForAnswer(k, { timeoutMs: 10 });
    await expect(p).rejects.toThrow(/timed out/i);
    expect(hasPendingAsk(k)).toBe(false);
  });

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
    const p = waitForAnswer(k, { timeoutMs: 5000 });
    cancelAsk(k, "turn aborted");
    await expect(p).rejects.toThrow(/turn aborted/i);
    expect(hasPendingAsk(k)).toBe(false);
  });

  test("cancelAsk also drops a buffered-but-unclaimed answer", async () => {
    const k = key();
    deliverAnswer(k, { Q: "stale" });
    cancelAsk(k, "torn down");
    // Buffer cleared: a later waiter must NOT resolve from the dropped answer;
    // it times out instead.
    await expect(waitForAnswer(k, { timeoutMs: 10 })).rejects.toThrow(/timed out/i);
  });

  test("deliverAnswer with no waiter always returns true (buffered)", () => {
    const k = key();
    expect(deliverAnswer(k, { Q: "A" })).toBe(true);
    cancelAsk(k); // cleanup
  });
});

describe("ask-user-bridge — quanto aspetta", () => {
  test("il default è tarato su un umano che si alza dalla scrivania", async () => {
    // 90 min: sopra la finestra di silenzio del watchdog (30 min, che ora esenta
    // le domande in volo) e SOTTO il cap di vita del child (2 h) — oltre quello
    // il processo viene ucciso e l'attesa finirebbe su un morto invece che su
    // questa cancellazione pulita.
    const k = key();
    const p = waitForAnswer(k); // nessun timeoutMs → default
    expect(hasPendingAsk(k)).toBe(true);
    // Non aspettiamo 90 minuti: basta che il default NON sia già scaduto dopo
    // un tempo in cui i vecchi 10 min sarebbero comunque stati vivi.
    await new Promise((r) => setTimeout(r, 20));
    expect(hasPendingAsk(k)).toBe(true);
    cancelAsk(k, "fine test");
    await expect(p).rejects.toThrow(/fine test/i);
  });
});
