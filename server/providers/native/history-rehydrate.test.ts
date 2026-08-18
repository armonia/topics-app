/**
 * Il runtime nativo teneva la conversazione in una Map di processo e diceva alla
 * rotta «la storia me la ricordo io». Su una macchina dove il server si riavvia
 * a ogni salvataggio in `server/`, quella promessa dura fino al salvataggio
 * dopo: il 2026-08-18 una chat con dentro un'analisi da 2.396 caratteri si è
 * sentita rispondere «Non ho trovato messaggi nel topic "New Chat"».
 *
 * Qui si prova la funzione che ricostruisce la storia dal DB. Ogni test è una
 * delle quattro regole, e ognuna è un modo in cui la trascrizione di Topics NON
 * coincide con quello che l'API accetta.
 */
import { test, expect, describe } from "bun:test";
import { historyFromPersistedThread, type PersistedTurn } from "./history-rehydrate";

const u = (content: string, partial?: number): PersistedTurn => ({ role: "user", content, partial });
const a = (content: string, partial?: number): PersistedTurn => ({ role: "assistant", content, partial });

describe("historyFromPersistedThread — ricostruire la storia dopo un riavvio", () => {
  test("thread vuoto ⇒ storia vuota", () => {
    expect(historyFromPersistedThread([])).toEqual([]);
  });

  test("il caso vero: domanda, risposta, nuova domanda ⇒ resta lo scambio, non la domanda in corso", () => {
    const out = historyFromPersistedThread([
      u("Giovanni ha lavorato bene ieri?"),
      a("Ho misurato: tre commit, 1h42 di finestra."),
      u("fammi un report di fine giornata"),
    ]);
    // La domanda in coda è quella del turno che sta per partire: `sendChat` la
    // rimette lui in fondo. Se restasse qui il modello la vedrebbe due volte.
    expect(out).toEqual([
      { role: "user", content: "Giovanni ha lavorato bene ieri?" },
      { role: "assistant", content: "Ho misurato: tre commit, 1h42 di finestra." },
    ]);
  });

  test("un turno tagliato a metà non è una risposta: si butta", () => {
    const out = historyFromPersistedThread([u("domanda"), a("meta' risposta", 1), u("altra domanda")]);
    expect(out).toEqual([{ role: "user", content: "domanda" }]);
  });

  test("le righe senza testo non entrano", () => {
    const out = historyFromPersistedThread([u("domanda"), a("   "), a("risposta vera"), u("nuova")]);
    expect(out).toEqual([
      { role: "user", content: "domanda" },
      { role: "assistant", content: "risposta vera" },
    ]);
  });

  /** Un messaggio di sistema iniettato è una riga assistant senza domanda davanti. */
  test("una storia che apre con l'assistente viene tagliata fino al primo user", () => {
    const out = historyFromPersistedThread([a("nota di sistema"), u("domanda"), a("risposta"), u("nuova")]);
    expect(out).toEqual([
      { role: "user", content: "domanda" },
      { role: "assistant", content: "risposta" },
    ]);
  });

  test("senza nessun user la storia è vuota, non è mezza storia", () => {
    expect(historyFromPersistedThread([a("nota"), a("altra nota")])).toEqual([]);
  });

  test("due assistant di fila si fondono: qui sono normali, per l'API sono un errore", () => {
    const out = historyFromPersistedThread([u("domanda"), a("prima parte"), a("seconda parte"), u("nuova")]);
    expect(out).toEqual([
      { role: "user", content: "domanda" },
      { role: "assistant", content: "prima parte\n\nseconda parte" },
    ]);
  });

  /**
   * L'ORDINE FRA «togli l'ultima» E «fondi» È IL PUNTO, e al primo giro l'avevo
   * sbagliato: fondendo prima, `seconda` e `terza` diventano una riga sola e
   * toglierla butta via anche `seconda` — cioè proprio la domanda rimasta senza
   * risposta, quella che il modello deve vedere. Si toglie UNA riga, poi si
   * fonde: `seconda` resta in coda, e chi chiama la fonde col messaggio nuovo.
   */
  test("due user di fila: esce solo l'ultimo, la domanda rimasta senza risposta resta", () => {
    const out = historyFromPersistedThread([u("prima"), a("risposta"), u("seconda"), u("terza")]);
    expect(out).toEqual([
      { role: "user", content: "prima" },
      { role: "assistant", content: "risposta" },
      { role: "user", content: "seconda" },
    ]);
  });

  test("un assistant in coda resta: la domanda nuova arriva dopo di lui", () => {
    const out = historyFromPersistedThread([u("domanda"), a("risposta")]);
    expect(out).toEqual([
      { role: "user", content: "domanda" },
      { role: "assistant", content: "risposta" },
    ]);
  });

  test("i ruoli sconosciuti cadono su user invece di far saltare il turno", () => {
    const out = historyFromPersistedThread([{ role: "system", content: "boh" }, a("risposta"), u("nuova")]);
    expect(out).toEqual([
      { role: "user", content: "boh" },
      { role: "assistant", content: "risposta" },
    ]);
  });
});
