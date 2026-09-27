/**
 * `flattenContent`: the text AND the images of an MCP response.
 *
 * Before this, an `image` block was flattened into `[image content]` and the
 * bytes vanished: an MCP server answering with a screenshot was
 * indistinguishable from one answering empty. This checks that the image
 * survives separate from the text, that text and images can coexist in the
 * same response, and that the cases already covered (a bare string, unknown
 * types) stay as before.
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
