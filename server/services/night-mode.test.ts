/**
 * Le prove che contano sono due, e nessuna delle due è «acceso → dispaccia»:
 *  1. un turno SCADUTO si spegne anche a macchina occupata (altrimenti resta in
 *     attesa per sempre e diventa una trappola il giorno dopo);
 *  2. l'orario di fine si calcola dall'ACCENSIONE, non dalla mezzanotte —
 *     acceso alle 23:00 con fine alle 10:00 significa domani mattina.
 *
 * @covers NIGHT-01, NIGHT-02, NIGHT-04
 */
import { describe, test, expect } from "bun:test";
import { decideNight, parseHHMM, deadlineFrom } from "./night-mode";

const base = {
  enabled: true,
  now: new Date("2026-08-04T02:00:00"),
  load1: 1,
  cores: 12,
  busySessions: 0,
};

describe("parseHHMM", () => {
  test("orari validi", () => {
    expect(parseHHMM("10:00")).toBe(600);
    expect(parseHHMM("00:00")).toBe(0);
    expect(parseHHMM("23:59")).toBe(1439);
    expect(parseHHMM(" 7:05 ")).toBe(425);
  });

  test("un valore malformato è null, NON «nessuna scadenza»", () => {
    // È la distinzione che impedisce a un errore di battitura di trasformare il
    // turno in permanente.
    for (const v of ["", "abc", "24:00", "10:60", "10", "1000", null, undefined]) {
      expect(parseHHMM(v as string)).toBeNull();
    }
  });
});

describe("deadlineFrom", () => {
  test("un'ora ancora da venire OGGI resta oggi", () => {
    const d = deadlineFrom(new Date("2026-08-04T02:00:00"), "10:00")!;
    expect(d.toISOString()).toBe(new Date("2026-08-04T10:00:00").toISOString());
  });

  test("un'ora GIÀ passata scivola a domani", () => {
    // Acceso alle 23:00 con fine alle 10:00: è domani mattina, non stamattina.
    const d = deadlineFrom(new Date("2026-08-03T23:00:00"), "10:00")!;
    expect(d.toISOString()).toBe(new Date("2026-08-04T10:00:00").toISOString());
  });

  test("acceso ESATTAMENTE all'ora di fine ⇒ domani, non subito", () => {
    // Altrimenti accendere alle 10:00 con fine alle 10:00 sarebbe un no-op
    // silenzioso invece di un turno di 24 ore.
    const d = deadlineFrom(new Date("2026-08-04T10:00:00"), "10:00")!;
    expect(d.toISOString()).toBe(new Date("2026-08-05T10:00:00").toISOString());
  });

  test("orario malformato: nessuna scadenza calcolabile", () => {
    expect(deadlineFrom(new Date(), "boh")).toBeNull();
  });
});

describe("decideNight", () => {
  test("spento: la board si comporta come sempre", () => {
    expect(decideNight({ ...base, enabled: false })).toEqual({ action: "off" });
  });

  test("macchina libera e orario non scaduto: via libera", () => {
    expect(decideNight({ ...base, untilHHMM: "10:00" })).toEqual({ action: "dispatch" });
  });

  test("qualcuno sta lavorando: si aspetta, e il motivo lo dice", () => {
    const d = decideNight({ ...base, busySessions: 2 });
    expect(d.action).toBe("wait");
    if (d.action === "wait") expect(d.reason).toContain("2 sessioni attive");
  });

  test("carico alto: si aspetta, con soglia PER CORE", () => {
    // 12 core × 1.5 = 18. Sopra si aspetta, sotto no — su una macchina da 4
    // core la stessa soglia assoluta sarebbe assurda.
    expect(decideNight({ ...base, load1: 18 }).action).toBe("wait");
    expect(decideNight({ ...base, load1: 17.9 }).action).toBe("dispatch");
    // 4 core × 1.5 = 6: sotto si lavora, da 6 in su si aspetta.
    expect(decideNight({ ...base, cores: 4, load1: 5.9 }).action).toBe("dispatch");
    expect(decideNight({ ...base, cores: 4, load1: 6 }).action).toBe("wait");
  });

  test("SCADUTO si spegne anche a macchina occupata", () => {
    // La prova che conta: se la scadenza fosse valutata dopo il carico, un
    // turno acceso su una macchina che resta occupata non finirebbe MAI.
    const d = decideNight({
      ...base,
      untilHHMM: "10:00",
      startedAt: new Date("2026-08-03T23:00:00"),
      now: new Date("2026-08-04T10:00:01"),
      busySessions: 5,
      load1: 40,
    });
    expect(d.action).toBe("expire");
  });

  test("un secondo PRIMA della scadenza si lavora ancora", () => {
    const d = decideNight({
      ...base,
      untilHHMM: "10:00",
      startedAt: new Date("2026-08-03T23:00:00"),
      now: new Date("2026-08-04T09:59:59"),
    });
    expect(d.action).toBe("dispatch");
  });

  test("senza orario di fine non scade mai (ma resta gated sul carico)", () => {
    expect(decideNight({ ...base, untilHHMM: null }).action).toBe("dispatch");
    expect(decideNight({ ...base, untilHHMM: null, load1: 99 }).action).toBe("wait");
  });

  test("orario malformato non diventa «nessuna scadenza» per sbaglio", () => {
    // `deadlineFrom` torna null e non si scade: il comportamento è lo stesso di
    // «nessun orario», ma passa da una validazione esplicita invece che da un
    // NaN che si propaga.
    expect(decideNight({ ...base, untilHHMM: "25:00" }).action).toBe("dispatch");
  });

  test("cores a zero non fa esplodere la soglia", () => {
    expect(decideNight({ ...base, cores: 0, load1: 1.6 }).action).toBe("wait");
    expect(decideNight({ ...base, cores: 0, load1: 1.4 }).action).toBe("dispatch");
  });
});
