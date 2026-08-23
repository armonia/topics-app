/**
 * Cosa esce di qui, per ogni gradino di privacy.
 *
 * Il test che conta non è «minimal ha meno campi»: è che a `minimal` e a
 * `activity` NON compaia mai un nome. Un livello di privacy si prova per ciò
 * che tiene dentro, non per ciò che mostra — e il modo in cui questi controlli
 * si rompono è sempre lo stesso, un campo aggiunto per il livello alto che
 * nessuno ha escluso dai livelli bassi.
 */

import { describe, expect, test } from "bun:test";
import { buildActivity, type PresenceSnapshot } from "./discord-activity";

const BASE: PresenceSnapshot = {
  openSessions: 12,
  workingSessions: 3,
  activeTasks: 2,
  focusProject: "Armonia-CRM",
  since: 1_700_000_000_000,
};

/** Ogni testo che finisce sul profilo, in una stringa sola. */
function tutto(a: ReturnType<typeof buildActivity>): string {
  return `${a?.details ?? ""} ${a?.state ?? ""}`;
}

describe("minimal", () => {
  test("dice solo che Topics è aperto: nessun numero, nessun nome", () => {
    const a = buildActivity(BASE, "minimal");
    expect(a).not.toBeNull();
    expect(tutto(a)).not.toContain("Armonia-CRM");
    expect(tutto(a)).not.toMatch(/\d/);
  });

  test("resta acceso anche a zero sessioni: a questo livello non c'è niente da nascondere", () => {
    const a = buildActivity({ ...BASE, openSessions: 0, workingSessions: 0, activeTasks: 0 }, "minimal");
    expect(a).not.toBeNull();
  });
});

describe("activity", () => {
  test("porta i CONTEGGI e nessun nome di progetto", () => {
    const a = buildActivity(BASE, "activity", "it");
    expect(a!.details).toContain("3");
    expect(a!.details).toContain("12");
    expect(tutto(a)).not.toContain("Armonia-CRM");
  });

  test("con nessuno al lavoro non dice «0 al lavoro»: dice quante sono aperte", () => {
    const a = buildActivity({ ...BASE, workingSessions: 0, activeTasks: 0 }, "activity", "it");
    expect(a!.details).toBe("12 chat aperte");
    expect(a!.state).toBe("Nessun agente al lavoro");
  });

  test("il singolare è singolare (in entrambe le lingue)", () => {
    const uno: PresenceSnapshot = { ...BASE, openSessions: 1, workingSessions: 0, activeTasks: 1 };
    expect(buildActivity(uno, "activity", "it")!.details).toBe("1 chat aperta");
    expect(buildActivity(uno, "activity", "it")!.state).toBe("1 task in corso");
    expect(buildActivity(uno, "activity", "en")!.details).toBe("1 chat open");
    expect(buildActivity(uno, "activity", "en")!.state).toBe("1 task running");
  });

  test("`auto` non è una lingua: il pubblico è internazionale, quindi inglese", () => {
    const a = buildActivity(BASE, "activity", "auto");
    expect(a!.details).toContain("working");
  });
});

describe("detailed", () => {
  test("è l'UNICO livello in cui esce il nome del progetto", () => {
    const a = buildActivity(BASE, "detailed", "it");
    expect(a!.state).toBe("su Armonia-CRM");
  });

  test("senza un progetto in primo piano degrada su activity, non pubblica «su null»", () => {
    const a = buildActivity({ ...BASE, focusProject: null }, "detailed", "it");
    expect(tutto(a)).not.toContain("null");
    expect(a!.state).toBe("2 task in corso");
  });

  test("un nome lunghissimo viene troncato a 128, come farebbe Discord", () => {
    const a = buildActivity({ ...BASE, focusProject: "x".repeat(400) }, "detailed", "it");
    expect(a!.state!.length).toBe(128);
    expect(a!.state!.endsWith("…")).toBe(true);
  });
});

describe("quando non c'è niente da dire", () => {
  test("zero sessioni e zero task ⇒ null, cioè PULISCI la presence", () => {
    const vuoto: PresenceSnapshot = { ...BASE, openSessions: 0, workingSessions: 0, activeTasks: 0 };
    expect(buildActivity(vuoto, "activity")).toBeNull();
    expect(buildActivity(vuoto, "detailed")).toBeNull();
  });

  test("zero sessioni ma un task in corso NON è vuoto: la board sta lavorando", () => {
    const a = buildActivity({ ...BASE, openSessions: 0, workingSessions: 0, activeTasks: 1 }, "activity", "it");
    expect(a).not.toBeNull();
    expect(a!.state).toBe("1 task in corso");
  });
});

describe("contorno", () => {
  test("il cronometro parte da `since`, in SECONDI (Discord non accetta i ms)", () => {
    const a = buildActivity(BASE, "activity");
    expect(a!.timestamps!.start).toBe(1_700_000_000);
  });

  test("l'immagine si attacca solo se c'è: nessun campo `assets` vuoto", () => {
    expect(buildActivity(BASE, "activity", "it", null)!.assets).toBeUndefined();
    expect(buildActivity(BASE, "activity", "it", "https://x/y.png")!.assets).toEqual({
      large_image: "https://x/y.png",
      large_text: "Topics",
    });
  });
});
