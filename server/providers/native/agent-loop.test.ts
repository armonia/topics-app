/**
 * `toolResultContent`: how a `ToolResult` becomes `tool_result.content`.
 *
 * Before this, every result was plain text, so an image (`ToolResult.images`)
 * had nowhere to go: `read_file` on a PNG or an inline screenshot ended up in
 * the text field as base64, which the API does not decode as an image. This
 * checks that a result WITHOUT images stays a plain string exactly as before,
 * and one WITH images becomes the `[text, ...images]` array the API expects,
 * with clipping applied only to the text part.
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
    // The image NEVER goes through `clipToolResult`: slicing base64 in half
    // would produce bytes that no longer decode to anything.
    expect(blocks[1].source.data).toBe("y".repeat(50_000));
  });
});
