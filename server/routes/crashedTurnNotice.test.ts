import { describe, expect, test } from "bun:test";
import { crashedTurnNotice, shortErrorDetail } from "./crashedTurnNotice";

describe("shortErrorDetail — l'errore vero, senza il code-frame", () => {
  test("un ReferenceError di Bun arriva col sorgente attaccato: si tiene la riga che conta", () => {
    // Esattamente la forma che ha ucciso il turno il 3 agosto.
    const err = new Error(
      '656 |           const trackedToolCallIds: string[] = [];\n' +
      '661 |           const humanWait = createHumanWaitLedger();\n' +
      '                                  ^\n' +
      'ReferenceError: createHumanWaitLedger is not defined',
    );
    expect(shortErrorDetail(err)).toBe("ReferenceError: createHumanWaitLedger is not defined");
  });

  test("taglia le sbrodolate, ma dice che ha tagliato", () => {
    const detail = shortErrorDetail(new Error("x".repeat(500)));
    expect(detail.length).toBe(200);
    expect(detail.endsWith("…")).toBe(true);
  });

  test("regge quello che errore non è", () => {
    expect(shortErrorDetail("socket chiuso")).toBe("socket chiuso");
    expect(shortErrorDetail(null)).toBe("errore senza messaggio");
    expect(shortErrorDetail(new Error(""))).toBe("errore senza messaggio");
  });
});

describe("crashedTurnNotice — quando si scrive, e quando si sta zitti", () => {
  const boom = new Error("ReferenceError: createHumanWaitLedger is not defined");

  test("riga vuota: si chiude dicendo di chi è la colpa e dov'è finito il messaggio", () => {
    const notice = crashedTurnNotice({ content: "", toolCallsJson: null }, boom);
    expect(notice).toContain("Errore interno di Topics");
    expect(notice).toContain("createHumanWaitLedger is not defined");
    expect(notice).toContain("Riprova");
    // Il ⚠️ non è decorazione: `MessageBubble` aggancia lì il bottone Riprova.
    expect(notice?.startsWith("⚠️")).toBe(true);
  });

  test("se il turno aveva già scritto qualcosa, quel qualcosa vale più dell'errore", () => {
    expect(crashedTurnNotice({ content: "Ecco la risposta", toolCallsJson: null }, boom)).toBeNull();
  });

  test("una riga con dei tool NON si sovrascrive: è il pannello domande che spariva", () => {
    const tools = JSON.stringify([{ id: "t1", name: "ask_user_question" }]);
    expect(crashedTurnNotice({ content: "", toolCallsJson: tools }, boom)).toBeNull();
  });

  test("array di tool vuoto = niente prodotto: si può chiudere", () => {
    expect(crashedTurnNotice({ content: "", toolCallsJson: "[]" }, boom)).not.toBeNull();
  });

  test("tool_calls illeggibile: nel dubbio non si tocca", () => {
    expect(crashedTurnNotice({ content: "", toolCallsJson: "{rotto" }, boom)).toBeNull();
  });

  test("nessuna riga da chiudere: niente da dire", () => {
    expect(crashedTurnNotice(null, boom)).toBeNull();
  });

  test("solo spazi non è contenuto", () => {
    expect(crashedTurnNotice({ content: "   \n ", toolCallsJson: null }, boom)).not.toBeNull();
  });
});
