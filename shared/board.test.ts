import { test, expect, describe } from "bun:test";
import {
  STATUS_EVENT_REASON_MAX,
  formatStatusEvent,
  parseStatusEvent,
  statusEventEnters,
} from "./board";

/**
 * Il formato dell'evento di stato ha UN writer e UN parser, perché lo leggono in
 * tre (il gate della consegna muta lato servizio, il dispatcher, la riga della
 * timeline). Finché la transizione era `from→to` e basta, ognuno se lo
 * spacchettava a modo suo; qui si pinna che la ragione non sposta il confine
 * della destinazione — cioè che i tre lettori continuano a leggere lo stesso
 * stato di prima.
 */
describe("evento di stato: from→to (· ragione)", () => {
  test("senza ragione il contenuto è identico a prima (le righe già scritte restano leggibili)", () => {
    expect(formatStatusEvent("todo", "in_progress")).toBe("todo→in_progress");
    expect(formatStatusEvent("todo", "in_progress", "")).toBe("todo→in_progress");
    expect(formatStatusEvent("todo", "in_progress", "   ")).toBe("todo→in_progress");
    expect(parseStatusEvent("todo→in_progress")).toEqual({ from: "todo", to: "in_progress", reason: null });
  });

  test("con ragione: la destinazione resta la destinazione", () => {
    const c = formatStatusEvent("done", "in_progress", "il land ha fatto conflitto con main");
    expect(c).toBe("done→in_progress · il land ha fatto conflitto con main");
    expect(parseStatusEvent(c)).toEqual({
      from: "done", to: "in_progress", reason: "il land ha fatto conflitto con main",
    });
    // Il predicato che i tre lettori usano davvero.
    expect(statusEventEnters(c, "in_progress")).toBe(true);
    expect(statusEventEnters(c, "done")).toBe(false);
  });

  test("una ragione con dentro una freccia o un altro separatore non sposta il confine", () => {
    const c = formatStatusEvent("review", "in_progress", "rifiutato: A → B · e poi C");
    expect(parseStatusEvent(c)?.to).toBe("in_progress");
    expect(parseStatusEvent(c)?.reason).toBe("rifiutato: A → B · e poi C");
    expect(statusEventEnters(c, "in_progress")).toBe(true);
  });

  test("la ragione è UNA riga e ha un tetto (è una riga di timeline, non un thread)", () => {
    const multi = formatStatusEvent("done", "in_progress", "  prima riga\n\nseconda   riga  ");
    expect(multi).toBe("done→in_progress · prima riga seconda riga");
    const long = formatStatusEvent("done", "in_progress", "x".repeat(500));
    expect(parseStatusEvent(long)!.reason!.length).toBe(STATUS_EVENT_REASON_MAX);
    expect(statusEventEnters(long, "in_progress")).toBe(true);
  });

  test("ciò che non è una transizione non viene letto come tale", () => {
    expect(parseStatusEvent("un commento qualunque")).toBeNull();
    expect(statusEventEnters("un commento qualunque", "in_progress")).toBe(false);
    // Un commento che PARLA di in_progress non è un inizio di turno: era il
    // rischio della lettura per suffisso (`endsWith`).
    expect(statusEventEnters("ho messo il task in in_progress", "in_progress")).toBe(false);
  });
});
