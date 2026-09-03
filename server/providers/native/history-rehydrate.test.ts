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
  * @covers RT-04
 */
import { test, expect, describe } from "bun:test";
import { historyFromPersistedThread, type PersistedTurn } from "./history-rehydrate";
import type { ToolCall } from "../../../shared/types";
import type { Block } from "./agent-loop";

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

/**
 * TOOL CALLS SURVIVE THE RESTART, not only the prose.
 *
 * Before this, `PersistedTurn` did not even have the field: an agent resumed
 * after a restart (or after eviction, or by the boot resume) saw its own
 * sentences and none of the files read or edited, none of the commands run.
 * Measured on topic:92c8ef85 on 2026-09-03: the agent had announced its delivery,
 * turn interrupted, a resume that explored from scratch.
 */
describe("historyFromPersistedThread — le coppie tool_use/tool_result", () => {
  const tc = (over: Partial<ToolCall> & { id: string }): ToolCall => ({
    name: "read_file", args: { path: "a.ts" }, status: "success", ...over,
  });
  const blocks = (m: { content: string | Block[] }): Block[] => m.content as Block[];

  test("una riga assistant con chiamate diventa assistant[testo, tool_use] → user[tool_result] → assistant[testo finale]", () => {
    const out = historyFromPersistedThread([
      u("leggi a.ts"),
      { role: "assistant", content: "Leggo il file.Fatto: 12 righe.", toolCalls: [
        tc({ id: "t1", result: "1\tconst x = 1", contentOffset: 14 }),
      ] },
      u("e ora?"),
    ]);
    expect(out).toEqual([
      { role: "user", content: "leggi a.ts" },
      { role: "assistant", content: [
        { type: "text", text: "Leggo il file." },
        { type: "tool_use", id: "t1", name: "read_file", input: { path: "a.ts" } },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "1\tconst x = 1" }] },
      { role: "assistant", content: "Fatto: 12 righe." },
    ]);
  });

  test("il risultato si legge da detail quando result e' stato tolto dal disco (leanToolCall)", () => {
    const out = historyFromPersistedThread([
      u("ls"),
      { role: "assistant", content: "", toolCalls: [
        tc({ id: "t1", name: "bash", args: { command: "ls" }, detail: { type: "shell", command: "ls", output: "a.ts\nb.ts" } }),
      ] },
      u("ok"),
    ]);
    const results = blocks(out[2]!);
    expect(results[0]).toEqual({ type: "tool_result", tool_use_id: "t1", content: "a.ts\nb.ts" });
  });

  test("una chiamata senza esito riceve un tool_result sintetico marcato errore, subito dopo il suo tool_use", () => {
    const out = historyFromPersistedThread([
      u("fai"),
      { role: "assistant", content: "Vado.", toolCalls: [tc({ id: "t1", status: "running", contentOffset: 5 })] },
      u("dopo"),
    ]);
    const r = blocks(out[2]!)[0]!;
    expect(r.type).toBe("tool_result");
    expect(r.tool_use_id).toBe("t1");
    expect(r.is_error).toBe(true);
    expect(String(r.content)).toContain("no result recorded");
  });

  test("un errore registrato e' un tool_result con is_error, non un buco", () => {
    const out = historyFromPersistedThread([
      u("fai"),
      { role: "assistant", content: "", toolCalls: [tc({ id: "t1", status: "error", error: "file non trovato" })] },
      u("dopo"),
    ]);
    expect(blocks(out[2]!)[0]).toEqual({ type: "tool_result", tool_use_id: "t1", content: "file non trovato", is_error: true });
  });

  test("chiamate allo stesso offset sono un giro: un assistant, un user con tutti i risultati", () => {
    const out = historyFromPersistedThread([
      u("leggi due file"),
      { role: "assistant", content: "Li leggo insieme.", toolCalls: [
        tc({ id: "t1", args: { path: "a" }, result: "A", contentOffset: 17 }),
        tc({ id: "t2", args: { path: "b" }, result: "B", contentOffset: 17 }),
      ] },
      u("grazie"),
    ]);
    expect(out.length).toBe(3);
    expect(blocks(out[1]!).map((b) => b.type)).toEqual(["text", "tool_use", "tool_use"]);
    expect(blocks(out[2]!).map((b) => b.tool_use_id)).toEqual(["t1", "t2"]);
  });

  test("due giri in una riga: il testo si spezza sugli offset, ogni giro ha la sua coppia", () => {
    const out = historyFromPersistedThread([
      u("sistema"),
      { role: "assistant", content: "Leggo.Modifico.Fatto.", toolCalls: [
        tc({ id: "t1", result: "src", contentOffset: 6 }),
        tc({ id: "t2", name: "edit_file", args: { path: "a", old: "x", new: "y" }, result: "ok", contentOffset: 15 }),
      ] },
      u("bene"),
    ]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
    expect(blocks(out[1]!)[0]).toEqual({ type: "text", text: "Leggo." });
    expect(blocks(out[3]!)[0]).toEqual({ type: "text", text: "Modifico." });
    expect(out[5]).toEqual({ role: "assistant", content: "Fatto." });
  });

  /** The measured case: the turn was cut, but the calls it made are facts. */
  test("un moncone CON chiamate tiene le coppie e butta solo il testo tagliato", () => {
    const out = historyFromPersistedThread([
      u("consegna"),
      { role: "assistant", content: "Committo.Tutto committato... Conse", partial: 1, toolCalls: [
        tc({ id: "t1", name: "bash", args: { command: "git commit" }, result: "[main abc] ok", contentOffset: 8 }),
      ] },
      u("hai consegnato?"),
    ]);
    expect(out).toEqual([
      { role: "user", content: "consegna" },
      { role: "assistant", content: [
        { type: "text", text: "Committo" },
        { type: "tool_use", id: "t1", name: "bash", input: { command: "git commit" } },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "[main abc] ok" }] },
    ]);
  });

  test("una coda di tool_result NON e' la domanda del turno che parte: non si toglie", () => {
    const out = historyFromPersistedThread([
      u("fai"),
      { role: "assistant", content: "", toolCalls: [tc({ id: "t1", result: "x" })] },
    ]);
    expect(out.length).toBe(3);
    expect(out[2]!.role).toBe("user");
    expect(blocks(out[2]!)[0]!.type).toBe("tool_result");
  });

  test("una domanda di prosa dopo una coda di risultati si fonde DOPO i risultati", () => {
    const out = historyFromPersistedThread([
      u("fai"),
      { role: "assistant", content: "", toolCalls: [tc({ id: "t1", result: "x" })] },
      u("rimasta senza risposta"),
      u("nuova"),
    ]);
    expect(blocks(out[2]!).map((b) => b.type)).toEqual(["tool_result", "text"]);
  });

  test("un risultato enorme salvato su disco entra tagliato, non intero", () => {
    const out = historyFromPersistedThread([
      u("leggi"),
      { role: "assistant", content: "", toolCalls: [tc({ id: "t1", result: "x".repeat(400_000) })] },
      u("ok"),
    ]);
    const r = blocks(out[2]!)[0]!;
    expect(String(r.content).length).toBeLessThan(60_000);
    expect(String(r.content)).toContain("chars omitted");
  });
});
