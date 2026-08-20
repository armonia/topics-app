import { describe, it, expect } from "bun:test";
import {
  awaitProcess, clampWaitTimeout, compileUntil, openWatch, watchesForProcess, countWatches,
  WAIT_DEFAULT_TIMEOUT_MS, WAIT_MAX_TIMEOUT_MS, type WaitSlice,
} from "./process-wait";

/**
 * L'orologio finto: il tempo avanza solo quando il ciclo dorme. Cosi' un
 * timeout di due minuti si prova in un millisecondo, e il test misura la
 * LOGICA invece di misurare la pazienza di chi lo guarda.
 */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
    advance: (ms: number) => { t += ms; },
  };
}

/** Un finto processo che sputa le righe che gli si danno, una per giro. */
function fakeProcess(steps: Array<Partial<WaitSlice>>) {
  let i = 0;
  let cursor = 0;
  return (offset: number): WaitSlice => {
    void offset;
    const step = steps[Math.min(i, steps.length - 1)] ?? {};
    i++;
    const output = step.output ?? "";
    if (output) cursor += output.split("\n").length;
    return {
      output,
      pending: step.pending ?? "",
      offset: cursor,
      done: step.done ?? false,
      status: step.status ?? (step.done ? "done" : "running"),
      ...(step.exitCode !== undefined ? { exitCode: step.exitCode } : {}),
      ...(step.truncatedLines !== undefined ? { truncatedLines: step.truncatedLines } : {}),
    };
  };
}

describe("clampWaitTimeout", () => {
  it("senza un numero utile torna il default, non zero", () => {
    expect(clampWaitTimeout(undefined)).toBe(WAIT_DEFAULT_TIMEOUT_MS);
    expect(clampWaitTimeout("banane")).toBe(WAIT_DEFAULT_TIMEOUT_MS);
    expect(clampWaitTimeout(0)).toBe(WAIT_DEFAULT_TIMEOUT_MS);
    expect(clampWaitTimeout(-5)).toBe(WAIT_DEFAULT_TIMEOUT_MS);
  });

  it("il tetto esiste perche' sopra ci sta il trasporto, non noi", () => {
    expect(clampWaitTimeout(10_000_000)).toBe(WAIT_MAX_TIMEOUT_MS);
    expect(clampWaitTimeout(30_000)).toBe(30_000);
    // Sotto il secondo non e' un'attesa, e' un sondaggio travestito.
    expect(clampWaitTimeout(10)).toBe(1_000);
  });

  it("accetta anche la stringa, che e' come arriva da una query", () => {
    expect(clampWaitTimeout("45000")).toBe(45_000);
  });
});

describe("compileUntil", () => {
  it("nessun motivo di fermarsi prima: nessuna regexp", () => {
    expect(compileUntil(undefined)).toBeUndefined();
    expect(compileUntil("")).toBeUndefined();
  });

  it("confronta senza distinguere maiuscole: i log non sono coerenti", () => {
    expect(compileUntil("READY")!.test("server ready in 300ms")).toBe(true);
  });

  it("una regexp storta torna un errore leggibile, non un'eccezione grezza", () => {
    expect(() => compileUntil("(")).toThrow(/not a valid regular expression/);
  });
});

describe("awaitProcess", () => {
  it("l'uscita si legge con un giro in piu': l'ultima riga e' quella che conta", async () => {
    const clock = fakeClock();
    const read = fakeProcess([
      { output: "building" },
      { output: "", done: true, status: "error", exitCode: 1 },
      // Il chunk arrivato DOPO che `exited` si era gia' risolta.
      { output: "FAIL src/a.test.ts", done: true, status: "error", exitCode: 1 },
    ]);
    const out = await awaitProcess({
      read, timeoutMs: 60_000, pollMs: 100, now: clock.now, sleep: clock.sleep,
    });
    expect(out.reason).toBe("exit");
    expect(out.exitCode).toBe(1);
    expect(out.output).toContain("FAIL src/a.test.ts");
  });

  it("`until` ferma l'attesa su un processo ancora VIVO", async () => {
    const clock = fakeClock();
    const read = fakeProcess([
      { output: "vite v5" },
      { output: "Local: http://localhost:5173" },
      { output: "…" },
    ]);
    const out = await awaitProcess({
      read, until: /localhost:\d+/i, timeoutMs: 60_000, pollMs: 100,
      now: clock.now, sleep: clock.sleep,
    });
    expect(out.reason).toBe("match");
    expect(out.status).toBe("running");
    expect(out.output).toContain("localhost:5173");
  });

  it("la riga a meta' conta per il confronto: «ready» senza a capo esiste", async () => {
    const clock = fakeClock();
    const read = fakeProcess([{ output: "", pending: "ready - compiled" }]);
    const out = await awaitProcess({
      read, until: /ready/i, timeoutMs: 5_000, pollMs: 100,
      now: clock.now, sleep: clock.sleep,
    });
    expect(out.reason).toBe("match");
    expect(out.output).toBe("ready - compiled");
  });

  it("scadere NON e' fallire: torna l'output nuovo e il cursore per ripartire", async () => {
    const clock = fakeClock();
    const read = fakeProcess([{ output: "tick" }]);
    const out = await awaitProcess({
      read, timeoutMs: 1_000, pollMs: 250, now: clock.now, sleep: clock.sleep,
    });
    expect(out.reason).toBe("timeout");
    expect(out.status).toBe("running");
    expect(out.offset).toBeGreaterThan(0);
    expect(out.waitedMs).toBeGreaterThanOrEqual(1_000);
  });

  it("le righe buttate dal ring buffer si SOMMANO lungo l'attesa", async () => {
    const clock = fakeClock();
    const read = fakeProcess([
      { output: "a", truncatedLines: 3 },
      { output: "b", truncatedLines: 2, done: true, status: "done", exitCode: 0 },
    ]);
    const out = await awaitProcess({
      read, timeoutMs: 10_000, pollMs: 100, now: clock.now, sleep: clock.sleep,
    });
    expect(out.reason).toBe("exit");
    expect(out.truncatedLines).toBe(7); // 3 + 2 + 2 (l'ultimo giro rilegge)
  });

  it("un processo gia' finito non fa aspettare nessuno", async () => {
    const clock = fakeClock();
    const read = fakeProcess([{ output: "done", done: true, status: "done", exitCode: 0 }]);
    const out = await awaitProcess({
      read, timeoutMs: 120_000, pollMs: 250, now: clock.now, sleep: clock.sleep,
    });
    expect(out.reason).toBe("exit");
    expect(out.waitedMs).toBeLessThan(1_000);
  });
});

describe("registro delle attese", () => {
  it("un'attesa aperta si vede sul suo processo, e solo su quello", () => {
    const prima = countWatches();
    const a = openWatch({ processId: "p1", label: "topic uno", timeoutMs: 1_000 });
    const b = openWatch({ processId: "p2", label: "topic due", until: "ready", timeoutMs: 1_000 });
    expect(watchesForProcess("p1").map(w => w.label)).toEqual(["topic uno"]);
    expect(watchesForProcess("p2")[0]?.until).toBe("ready");
    expect(countWatches()).toBe(prima + 2);
    a.close();
    expect(watchesForProcess("p1")).toEqual([]);
    b.close();
    expect(countWatches()).toBe(prima);
  });

  it("due attese sullo stesso processo si contano tutt'e due", () => {
    const a = openWatch({ processId: "p3", label: "uno", timeoutMs: 1_000 });
    const b = openWatch({ processId: "p3", label: "due", timeoutMs: 1_000 });
    expect(watchesForProcess("p3")).toHaveLength(2);
    a.close();
    expect(watchesForProcess("p3").map(w => w.label)).toEqual(["due"]);
    b.close();
  });

  it("chiudere due volte non toglie l'attesa di qualcun altro", () => {
    const a = openWatch({ processId: "p4", label: "uno", timeoutMs: 1_000 });
    const b = openWatch({ processId: "p4", label: "due", timeoutMs: 1_000 });
    a.close();
    a.close();
    expect(watchesForProcess("p4")).toHaveLength(1);
    b.close();
  });
});
