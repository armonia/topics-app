/**
 * Le prove di `ripresa-automatica.ts`.
 *
 * Il caso che conta è il primo — un turno morto per lo spegnimento riprende —
 * ma i quattro «no» pesano di più: una ripresa sbagliata costa un turno vero,
 * a pagamento, e in un ciclo li costa tutti.
 *
 * @covers RESUME-01
 */
import { describe, expect, test } from "bun:test";
import { meritaRipresaAutomatica, type StatoRipresa } from "./ripresa-automatica";

const sano: StatoRipresa = {
  fine: { end: "cancelled", cause: "server-shutdown" },
  chatViva: true,
  turnoInCorso: false,
  giaRipreso: false,
};

describe("chi riprende da solo", () => {
  test("morto per lo spegnimento del server: riprende", () => {
    expect(meritaRipresaAutomatica(sano)).toBe(true);
  });

  test("anche watchdog e limite di tempo: sono decisioni della macchina", () => {
    for (const cause of ["watchdog", "wall-clock"] as const) {
      expect(meritaRipresaAutomatica({ ...sano, fine: { end: "cancelled", cause } })).toBe(true);
    }
  });

  test("fermato dall'utente: NON riprende", () => {
    // Chi preme Ferma ha detto una cosa sola. Riprendere sarebbe disobbedire —
    // e costargli il turno che aveva appena deciso di non volere.
    expect(meritaRipresaAutomatica({ ...sano, fine: { end: "cancelled", cause: "user" } })).toBe(false);
  });

  test("annullato senza causa: NON riprende", () => {
    // Stessa regola di `cancelled-notice`: non si indovina chi ha annullato.
    // Il cartello è reversibile, una ripresa sbagliata no.
    expect(meritaRipresaAutomatica({ ...sano, fine: { end: "cancelled" } })).toBe(false);
  });

  test("finito bene, o con un errore vero: non c'è niente da riprendere", () => {
    expect(meritaRipresaAutomatica({ ...sano, fine: { end: "end_turn" } })).toBe(false);
    expect(meritaRipresaAutomatica({ ...sano, fine: { end: "error", cause: "provider-error" } })).toBe(false);
    expect(meritaRipresaAutomatica({ ...sano, fine: undefined })).toBe(false);
  });

  test("chat archiviata o inesistente: non si scrive dove l'utente non guarda", () => {
    expect(meritaRipresaAutomatica({ ...sano, chatViva: false })).toBe(false);
  });

  test("qualcuno sta già parlando: non si accavalla", () => {
    // L'utente ha riscritto nel frattempo, o il turno è già stato riadottato.
    expect(meritaRipresaAutomatica({ ...sano, turnoInCorso: true })).toBe(false);
  });

  test("già ripreso una volta: mai due", () => {
    // È il freno che rende la cosa sicura. Un guasto che si ripete — un file
    // salvato ogni dieci secondi, un watchdog che scatta sempre — diventerebbe
    // un ciclo che brucia token da solo, senza che nessuno l'abbia chiesto.
    expect(meritaRipresaAutomatica({ ...sano, giaRipreso: true })).toBe(false);
  });
});

/**
 * @covers RESUME-04
 */
describe("il limite dell'API", () => {
  test("esaurito per tutti i tentativi: e' della macchina, riprende", () => {
    expect(meritaRipresaAutomatica({ ...sano, fine: { end: "error", cause: "rate-limit" } })).toBe(true);
  });
  test("un altro errore del provider: no", () => {
    expect(meritaRipresaAutomatica({ ...sano, fine: { end: "error", cause: "provider-error" } })).toBe(false);
  });
});
