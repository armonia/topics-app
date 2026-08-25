/**
 * The summary, tested where it lives: one single phrase for the Discord
 * profile and for the status bar.
 *
 * What is proven here and what is not: the two lines of the card already have
 * their own test per privacy step (`server/services/discord-activity.test.ts`).
 * What gets proven here is what that file could not prove while the phrase
 * lived inside it: that the bar's line is made of the SAME pieces, and not of
 * a second writing that one day will say something else.
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
    // 12 topics and 2 external processes: the total «14» would answer no
    // question, because it counts two different things.
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
    // and a caller that does not know about them at all behaves the same
    expect(presenceLines(BASE, "it").details).toBe("3 al lavoro · 12 chat aperte");
  });

  test("anche a fermo le esterne restano visibili: e' l'unico lavoro in corso", () => {
    const fermo = { ...BASE, workingSessions: 0, activeTasks: 0, externalSessions: 1 };
    expect(presenceLines(fermo, "it").details).toBe("12 chat aperte · 1 fuori da Topics");
  });
});

describe("le esterne che stanno lavorando", () => {
  test("se lavora solo una esterna, la seconda riga NON dichiara il silenzio", () => {
    const c = { ...BASE, workingSessions: 0, activeTasks: 0, externalSessions: 4, externalWorking: 1 };
    const r = presenceLines(c, "it");
    // the two lines used to contradict each other: the first said «1 al  allow-italian: quotes the two Italian lines that clashed
    // lavoro fuori», the second «Nessun agente al lavoro».  allow-italian: quotes the two Italian lines that clashed
    expect(r.details).toContain("1 al lavoro fuori da Topics");
    expect(r.state).not.toBe("Nessun agente al lavoro");
  });

  test("se non lavora nessuno, dentro ne fuori, il silenzio resta dichiarato", () => {
    const c = { ...BASE, workingSessions: 0, activeTasks: 0, externalSessions: 4, externalWorking: 0 };
    expect(presenceLines(c, "it").state).toBe("Nessun agente al lavoro");
  });

  test("se una macina, la frase lo dice invece di darle per ferme", () => {
    const c = { ...BASE, externalSessions: 4, externalWorking: 1 };
    expect(presenceLines(c, "it").details).toBe("3 al lavoro · 12 chat aperte · 1 al lavoro fuori da Topics (su 4)");
    expect(presenceLines(c, "en").details).toBe("3 working · 12 chats open · 1 working outside Topics (of 4)");
  });

  test("se nessuna lavora si torna al conteggio semplice", () => {
    const c = { ...BASE, externalSessions: 4, externalWorking: 0 };
    expect(presenceLines(c, "it").details).toContain("4 fuori da Topics");
  });

  test("un chiamante che non conosce il campo si comporta come prima", () => {
    const c = { ...BASE, externalSessions: 4 };
    expect(presenceLines(c, "it").details).toContain("4 fuori da Topics");
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
    // On the profile the same name only comes out at the `detailed` step: it
    // is the only difference between the two surfaces, and it is deliberate.
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
