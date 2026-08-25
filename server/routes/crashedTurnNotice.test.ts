/**
 * The notice a crashed turn leaves in the chat: the real error without the
 * code frame, and written only when the row carries no work of its own.
 * @covers CHAT-REL-02
 */
import { describe, expect, test } from "bun:test";
import { crashedTurnNotice, rowCarriesWork, sendFailureNotice, shortErrorDetail } from "./crashedTurnNotice";

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

  test("content vuoto ma blocks pieni: a schermo è un turno intero, non si tocca", () => {
    // Il caso che la guardia a due colonne non vedeva. La prosa è persistita in
    // DUE posti e il client rende `blocks`: giudicare dalla sola `content`
    // significa cancellare un turno che l'utente sta leggendo.
    const blocks = JSON.stringify([{ kind: "text", text: "Piano scritto. In sintesi: …" }]);
    expect(crashedTurnNotice({ content: "", toolCallsJson: null, blocksJson: blocks }, boom)).toBeNull();
  });

  test("blocks vuoto o illeggibile: array vuoto si può chiudere, JSON rotto no", () => {
    expect(crashedTurnNotice({ content: "", toolCallsJson: null, blocksJson: "[]" }, boom)).not.toBeNull();
    expect(crashedTurnNotice({ content: "", toolCallsJson: null, blocksJson: "{rotto" }, boom)).toBeNull();
  });
});

describe("sendFailureNotice — il turno che non si è potuto guidare", () => {
  const giu = new Error("ai-bridge: ack timeout (spawn topic:x, 20s)");

  test("riga vuota: si dice cos'è successo e dov'è finito il messaggio", () => {
    const n = sendFailureNotice({ content: "", toolCallsJson: null, blocksJson: null }, giu);
    expect(n).toContain("Non sono riuscito ad avviare il turno");
    expect(n).toContain("ack timeout");
    expect(n).toContain("Riprova");
    expect(n?.startsWith("⚠️")).toBe(true);
  });

  test("riga che porta lavoro: il cartello NON si scrive, in tutte e tre le colonne", () => {
    expect(sendFailureNotice({ content: "una risposta", toolCallsJson: null, blocksJson: null }, giu)).toBeNull();
    expect(sendFailureNotice({ content: "", toolCallsJson: '[{"id":"t1"}]', blocksJson: null }, giu)).toBeNull();
    expect(sendFailureNotice({ content: "", toolCallsJson: null, blocksJson: '[{"kind":"text","text":"x"}]' }, giu)).toBeNull();
  });

  test("riga illeggibile: qui il cartello SI scrive", () => {
    // Differenza voluta rispetto a `crashedTurnNotice`: là il `null` significa
    // «non c'è una riga da toccare», qui «non so cosa c'è dentro» — e una bolla
    // vuota senza spiegazione è l'esito peggiore.
    expect(sendFailureNotice(null, giu)).not.toBeNull();
  });
});

describe("rowCarriesWork — la domanda sola, senza testo attorno", () => {
  test("le tre colonne contano tutte e tre", () => {
    expect(rowCarriesWork({ content: "", toolCallsJson: null, blocksJson: null })).toBe(false);
    expect(rowCarriesWork({ content: " ", toolCallsJson: "[]", blocksJson: "[]" })).toBe(false);
    expect(rowCarriesWork({ content: "x", toolCallsJson: null, blocksJson: null })).toBe(true);
    expect(rowCarriesWork({ content: "", toolCallsJson: '[{"id":"t"}]', blocksJson: null })).toBe(true);
    expect(rowCarriesWork({ content: "", toolCallsJson: null, blocksJson: '[{"kind":"text"}]' })).toBe(true);
    expect(rowCarriesWork(null)).toBe(false);
  });
});
