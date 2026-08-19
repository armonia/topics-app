/**
 * UN BLOCCO CHE TORNA ALL'API PORTA SOLO CIÒ CHE QUEL TIPO AMMETTE.
 *
 * ── Il guasto (19/08/2026) ─────────────────────────────────────────────────
 * `content_block_start` inizializzava OGNI blocco con `text: ""` e `input: {}`
 * — impalcatura utile ad accumulare i delta — e `forApi` rimandava il blocco
 * `thinking` verbatim, «intero, firma compresa». Le due cose insieme spedivano
 * all'API un pensiero con dentro un `text`, e la risposta era:
 *
 *     API 400: messages.9.content.0.thinking.text: Extra inputs are not permitted
 *
 * Otto topic in una volta, tutte le card della board ferme. Non si era mai visto
 * perché il catalogo dei modelli declassava a un modello che i blocchi di
 * pensiero non li produceva: il difetto era lì da prima, coperto da un altro
 * difetto. Appena il primo è stato corretto, il secondo è uscito.
 *
 * ── Cosa misura questo file ────────────────────────────────────────────────
 * Che la ripulitura sia per COSTRUZIONE e non per sottrazione: si riscrive il
 * blocco con i campi ammessi, invece di sperare che non ne arrivino di nuovi.
 */
import { describe, expect, test } from "bun:test";
import { forApi, type Block } from "./agent-loop";

/** Un blocco come lo costruisce davvero lo streaming, impalcatura inclusa. */
function comeDalloStream(b: Partial<Block> & { type: string }): Block {
  return { text: "", input: {}, ...b } as Block;
}

describe("i blocchi che tornano all'API", () => {
  test("il pensiero perde l'impalcatura e tiene la firma", () => {
    const out = forApi([comeDalloStream({ type: "thinking", thinking: "ragiono", signature: "sig-abc" })]);
    expect(out[0]).toEqual({ type: "thinking", thinking: "ragiono", signature: "sig-abc" });
    // La forma esatta conta: `toEqual` su un oggetto letterale boccia ogni
    // campo in più, che è precisamente ciò che l'API rifiutava.
    expect(Object.keys(out[0]!).sort()).toEqual(["signature", "thinking", "type"]);
  });

  test("senza firma il campo non si inventa vuoto", () => {
    // Una `signature: ""` non è «nessuna firma»: è una firma sbagliata, e
    // l'API la valuta come tale.
    const out = forApi([comeDalloStream({ type: "thinking", thinking: "ragiono" })]);
    expect("signature" in out[0]!).toBe(false);
  });

  test("il pensiero oscurato porta solo il suo corpo cifrato", () => {
    const out = forApi([comeDalloStream({ type: "redacted_thinking", data: "cifrato" })]);
    expect(out[0]).toEqual({ type: "redacted_thinking", data: "cifrato" });
  });

  test("testo e tool_use continuano a passare interi", () => {
    const out = forApi([
      comeDalloStream({ type: "text", text: "ciao" }),
      comeDalloStream({ type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } }),
    ]);
    expect(out[0]).toEqual({ type: "text", text: "ciao" });
    expect(out[1]).toEqual({ type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } });
  });

  test("IL PREDICATO MORDE: il vecchio passaggio verbatim sarebbe stato bocciato", () => {
    // Senza questo caso i controlli sopra resterebbero verdi anche se qualcuno
    // rimettesse `return b`, purché lo stream smettesse di aggiungere `text`.
    const grezzo = comeDalloStream({ type: "thinking", thinking: "ragiono", signature: "sig" });
    expect(Object.keys(grezzo)).toContain("text"); // è quello che l'API rifiuta
    expect(forApi([grezzo])[0]).not.toHaveProperty("text");
  });
});
