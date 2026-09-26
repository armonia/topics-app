/**
 * `toolResultContent`: come diventa `tool_result.content` un `ToolResult`.
 *
 * Prima ogni risultato era testo puro, quindi un'immagine (`ToolResult.images`)
 * non aveva dove andare: `read_file` su un PNG o uno screenshot inline
 * finivano nel campo testo come base64, che l'API non decodifica come
 * immagine. Qui si verifica che un risultato SENZA immagini resta una
 * stringa esattamente come prima, e uno CON immagini diventa l'array
 * `[testo, ...immagini]` che l'API si aspetta — con la clip applicata solo
 * alla parte di testo.
  * @covers RT-11
 */
import { describe, test, expect } from "bun:test";
import { toolResultContent } from "./agent-loop";
import type { ToolResult } from "./tools";

describe("toolResultContent", () => {
  test("nessuna immagine: il contenuto resta una semplice stringa, come sempre", () => {
    const out: ToolResult = { content: "ok, scritto" };
    expect(toolResultContent(out)).toBe("ok, scritto");
  });

  test("un'immagine: il contenuto diventa [testo, immagine]", () => {
    const out: ToolResult = {
      content: "a.png (10x10, image attached)",
      images: [{ mediaType: "image/png", data: "QUFB" }],
    };
    const content = toolResultContent(out);
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as any[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "a.png (10x10, image attached)" });
    expect(blocks[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "QUFB" },
    });
  });

  test("più immagini nello stesso risultato producono più blocchi immagine", () => {
    const out: ToolResult = {
      content: "due schermate",
      images: [
        { mediaType: "image/png", data: "QQ==" },
        { mediaType: "image/jpeg", data: "Qg==" },
      ],
    };
    const blocks = toolResultContent(out) as any[];
    expect(blocks).toHaveLength(3);
    expect(blocks[1].source.media_type).toBe("image/png");
    expect(blocks[2].source.media_type).toBe("image/jpeg");
  });

  test("un array `images` vuoto si comporta come nessuna immagine", () => {
    const out: ToolResult = { content: "niente da vedere", images: [] };
    expect(toolResultContent(out)).toBe("niente da vedere");
  });

  test("il testo di un'immagine viene comunque tagliato se troppo lungo, i byte dell'immagine no", () => {
    const out: ToolResult = {
      content: "x".repeat(50_000),
      images: [{ mediaType: "image/png", data: "y".repeat(50_000) }],
    };
    const blocks = toolResultContent(out) as any[];
    expect(blocks[0].text.length).toBeLessThan(50_000);
    // L'immagine non passa MAI da `clipToolResult`: tagliare il base64 a metà
    // produrrebbe byte che non decodificano più a niente.
    expect(blocks[1].source.data).toBe("y".repeat(50_000));
  });
});
