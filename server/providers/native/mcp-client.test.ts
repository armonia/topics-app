/**
 * `flattenContent`: il testo E le immagini di una risposta MCP.
 *
 * Prima un blocco `image` finiva flattenato in `[image content]` e i byte
 * sparivano: un server MCP che rispondeva a uno screenshot era indistinguibile
 * da uno che rispondeva vuoto. Qui si verifica che l'immagine sopravvive
 * separata dal testo, che testo e immagini possono convivere nella stessa
 * risposta, e che i casi già coperti (stringa nuda, tipi sconosciuti) restano
 * come prima.
  * @covers RT-11
 */
import { describe, test, expect } from "bun:test";
import { flattenContent } from "./mcp-client";

describe("flattenContent", () => {
  test("un blocco immagine torna in `images`, non appiattito nel testo", () => {
    const r = flattenContent({
      content: [{ type: "image", data: "QUFB", mimeType: "image/png" }],
    });
    expect(r.content).toBe("");
    expect(r.images).toEqual([{ mediaType: "image/png", data: "QUFB" }]);
  });

  test("testo e immagine nella stessa risposta convivono", () => {
    const r = flattenContent({
      content: [
        { type: "text", text: "ecco lo screenshot" },
        { type: "image", data: "QUFB", mimeType: "image/png" },
      ],
    });
    expect(r.content).toBe("ecco lo screenshot");
    expect(r.images).toEqual([{ mediaType: "image/png", data: "QUFB" }]);
  });

  test("più immagini si accumulano tutte", () => {
    const r = flattenContent({
      content: [
        { type: "image", data: "QQ==", mimeType: "image/png" },
        { type: "image", data: "Qg==", mimeType: "image/jpeg" },
      ],
    });
    expect(r.images).toHaveLength(2);
  });

  test("solo testo: nessun campo `images`, come prima", () => {
    const r = flattenContent({ content: [{ type: "text", text: "ok" }] });
    expect(r.content).toBe("ok");
    expect(r.images).toBeUndefined();
  });

  test("un tipo sconosciuto resta annunciato, non sparisce", () => {
    const r = flattenContent({ content: [{ type: "resource" }] });
    expect(r.content).toBe("[resource content]");
    expect(r.images).toBeUndefined();
  });

  test("una risposta che è già una stringa passa dritta", () => {
    expect(flattenContent({ content: "già testo" })).toEqual({ content: "già testo" });
  });

  test("un'immagine senza `mimeType` non è un blocco immagine valido: viene annunciata", () => {
    const r = flattenContent({ content: [{ type: "image", data: "QQ==" }] });
    expect(r.images).toBeUndefined();
    expect(r.content).toBe("[image content]");
  });
});
