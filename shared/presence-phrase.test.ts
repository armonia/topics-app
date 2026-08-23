/**
 * Il riepilogo, provato dove vive: una frase sola per il profilo Discord e per
 * la barra di stato.
 *
 * Cosa si prova qui e cosa no: le due righe della card hanno gia' il loro test
 * per gradino di privacy (`server/services/discord-activity.test.ts`). Qui si
 * prova cio' che quel file non poteva provare finche' la frase stava dentro di
 * lui: che la riga della barra sia fatta degli STESSI pezzi, e non di una
 * seconda scrittura che un giorno dira' un'altra cosa.
 */

import { describe, expect, test } from "bun:test";
import { presenceLines, presenceSummary, type PresenceCounts } from "./presence-phrase";

const BASE: PresenceCounts = {
  openSessions: 12,
  workingSessions: 3,
  activeTasks: 2,
  focusProject: "Armonia-CRM",
};

describe("le sessioni aperte fuori da Topics", () => {
  test("si nominano a parte invece di sommarsi alle aperte", () => {
    const c = { ...BASE, externalSessions: 2 };
    // 12 topic e 2 processi esterni: il totale «14» non risponderebbe a
    // nessuna domanda, perche' conta due cose diverse.
    expect(presenceLines(c, "it").details).toBe("3 al lavoro · 12 chat aperte · 2 fuori da Topics");
    expect(presenceLines(c, "en").details).toBe("3 working · 12 chats open · 2 outside Topics");
  });

  test("una sola sessione esterna si dice al singolare", () => {
    const c = { ...BASE, externalSessions: 1 };
    expect(presenceLines(c, "it").details).toContain("1 fuori da Topics");
    expect(presenceLines(c, "en").details).toContain("1 outside Topics");
  });

  test("zero esterne non lascia un separatore appeso", () => {
    expect(presenceLines({ ...BASE, externalSessions: 0 }, "it").details).toBe("3 al lavoro · 12 chat aperte");
    // e un chiamante che non le conosce affatto si comporta uguale
    expect(presenceLines(BASE, "it").details).toBe("3 al lavoro · 12 chat aperte");
  });

  test("anche a fermo le esterne restano visibili: e' l'unico lavoro in corso", () => {
    const fermo = { ...BASE, workingSessions: 0, activeTasks: 0, externalSessions: 1 };
    expect(presenceLines(fermo, "it").details).toBe("12 chat aperte · 1 fuori da Topics");
  });
});

describe("le due righe", () => {
  test("con qualcuno al lavoro dicono chi lavora e su quante aperte", () => {
    expect(presenceLines(BASE, "it").details).toBe("3 al lavoro · 12 chat aperte");
    expect(presenceLines(BASE, "en").details).toBe("3 working · 12 chats open");
  });

  test("a fermo non dicono «0 al lavoro»: dicono quante sessioni hai aperte", () => {
    const fermo = { ...BASE, workingSessions: 0, activeTasks: 0 };
    expect(presenceLines(fermo, "it")).toEqual({
      details: "12 chat aperte",
      state: "Nessun agente al lavoro",
    });
  });

  test("`auto` non è una lingua: senza una scelta si parla inglese", () => {
    expect(presenceLines(BASE).details).toContain("working");
  });
});

describe("la riga della barra", () => {
  test("è fatta dei pezzi delle due righe, più il progetto", () => {
    const { details, state } = presenceLines(BASE, "it");
    const riga = presenceSummary(BASE, "it")!;
    expect(riga).toContain(details);
    expect(riga).toContain(state);
    expect(riga).toBe("3 al lavoro · 12 chat aperte · 2 task in corso · su Armonia-CRM");
  });

  test("il nome del progetto ESCE, perché qui il pubblico sei tu", () => {
    // Sul profilo lo stesso nome esce solo al gradino `detailed`: e' la sola
    // differenza fra le due superfici, ed e' voluta.
    expect(presenceSummary(BASE, "it")).toContain("Armonia-CRM");
  });

  test("senza un progetto in primo piano non si scrive «su null»", () => {
    const riga = presenceSummary({ ...BASE, focusProject: null }, "it")!;
    expect(riga).not.toContain("null");
    expect(riga).toBe("3 al lavoro · 12 chat aperte · 2 task in corso");
  });

  test("«Topics» non entra nella riga: accanto al nome della finestra non aggiunge niente", () => {
    const riga = presenceSummary({ ...BASE, activeTasks: 0 }, "it")!;
    expect(riga).toBe("3 al lavoro · 12 chat aperte · su Armonia-CRM");
  });

  test("a fermo la riga dichiara il silenzio invece di sparire a metà", () => {
    const riga = presenceSummary({ ...BASE, workingSessions: 0, activeTasks: 0 }, "it")!;
    expect(riga).toBe("12 chat aperte · Nessun agente al lavoro · su Armonia-CRM");
  });

  test("niente sessioni e niente task ⇒ nessuna riga, lo stesso caso in cui la presence si pulisce", () => {
    expect(presenceSummary({ openSessions: 0, workingSessions: 0, activeTasks: 0, focusProject: null })).toBeNull();
  });

  test("zero sessioni ma un task in corso NON è vuoto: la board sta lavorando", () => {
    const riga = presenceSummary({ openSessions: 0, workingSessions: 0, activeTasks: 1, focusProject: null }, "it");
    expect(riga).toBe("0 chat aperte · 1 task in corso");
  });
});
