/**
 * `toolResultContent`: how a `ToolResult` becomes `tool_result.content`.
 *
 * Before this, every result was plain text, so an image (`ToolResult.images`)
 * had nowhere to go: `read_file` on a PNG or an inline screenshot ended up in
 * the text field as base64, which the API does not decode as an image. This
 * checks that a result WITHOUT images stays a plain string exactly as before,
 * and one WITH images becomes the `[text, ...images]` array the API expects,
 * with clipping applied only to the text part.
 *
 * WHY REAL PNG BYTES, not the old fake `"QUFB"` (="AAA") base64. Every image
 * now passes through `normalizeImage` (`image-normalize.ts`) at this exact
 * seam, and undecodable bytes correctly become a TEXT fallback rather than a
 * broken image block — which is the whole point of the fix (RT-11 finding
 * #2/#3), but it means a fake fixture no longer produces an image block here.
 * The genuinely-decodable-image tests are darwin-only because the resize/
 * recompress step (`sips`) only runs there; on any other platform an image
 * always becomes a text note naming why, which is covered separately below
 * and runs everywhere, CI included.
 *
 * @covers RT-11
 */
import { describe, test, expect } from "bun:test";
import { deflateSync, crc32 } from "node:zlib";
import { toolResultContent } from "./agent-loop";
import type { ToolResult } from "./tools";

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(Number(crc32(typeAndData)) >>> 0, 0);
  return Buffer.concat([len, typeAndData, crc]);
}

/** A REAL, `sips`-decodable PNG: flat colour, valid IDAT, valid CRCs. */
function realPng(width: number, height: number, rgb: [number, number, number] = [90, 140, 200]): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(width).fill(rgb).flat())]);
  const raw = Buffer.concat(Array(height).fill(row));
  const idat = deflateSync(raw);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

const isDarwin = process.platform === "darwin";

describe("toolResultContent", () => {
  test("nessuna immagine: il contenuto resta una semplice stringa, come sempre", () => {
    const out: ToolResult = { content: "ok, scritto" };
    expect(toolResultContent(out)).toBe("ok, scritto");
  });

  test("un array `images` vuoto si comporta come nessuna immagine", () => {
    const out: ToolResult = { content: "niente da vedere", images: [] };
    expect(toolResultContent(out)).toBe("niente da vedere");
  });

  test("byte che non decodificano a nessuna immagine: il testo resta stringa, con la ragione allegata", () => {
    const out: ToolResult = {
      content: "a.png (10x10, image attached)",
      images: [{ mediaType: "image/png", data: Buffer.from("non un'immagine vera").toString("base64") }],
    };
    const content = toolResultContent(out);
    expect(typeof content).toBe("string");
    expect(content as string).toContain("a.png (10x10, image attached)");
    expect((content as string).toLowerCase()).toContain("non riconosciuto");
  });

  test.if(isDarwin)("un'immagine reale: il contenuto diventa [testo, immagine]", () => {
    const bytes = realPng(10, 10);
    const out: ToolResult = {
      content: "a.png (10x10, image attached)",
      images: [{ mediaType: "image/png", data: bytes.toString("base64") }],
    };
    const content = toolResultContent(out);
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as any[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "text", text: "a.png (10x10, image attached)" });
    expect(blocks[1].type).toBe("image");
    // Recompressed to JPEG regardless of the input format: this is the byte
    // ceiling, not just a pixel one (finding #1).
    expect(blocks[1].source.media_type).toBe("image/jpeg");
  });

  test.if(isDarwin)("più immagini nello stesso risultato producono più blocchi immagine", () => {
    const out: ToolResult = {
      content: "due schermate",
      images: [
        { mediaType: "image/png", data: realPng(10, 10, [10, 20, 30]).toString("base64") },
        { mediaType: "image/jpeg", data: realPng(12, 8, [200, 30, 10]).toString("base64") },
      ],
    };
    const blocks = toolResultContent(out) as any[];
    expect(blocks).toHaveLength(3);
    expect(blocks[1].source.media_type).toBe("image/jpeg");
    expect(blocks[2].source.media_type).toBe("image/jpeg");
  });

  test.if(isDarwin)("il testo di un'immagine viene comunque tagliato se troppo lungo, l'immagine no", () => {
    const out: ToolResult = {
      content: "x".repeat(50_000),
      images: [{ mediaType: "image/png", data: realPng(10, 10).toString("base64") }],
    };
    const blocks = toolResultContent(out) as any[];
    expect(blocks[0].text.length).toBeLessThan(50_000);
    expect(blocks[1].type).toBe("image");
  });
});
