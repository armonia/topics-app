/**
 * `normalizeImage`: one image, real bytes in, a safe block or a text reason
 * out.
 *
 * WHY REAL BYTES. The image passed to `read_file`'s own test suite before
 * this file used a header-only PNG with no actual pixel data past the IHDR
 * chunk (`pngHeader(3000, 3000)`): `sips` cannot decode that, so the resize
 * silently fell back to the ORIGINAL bytes, and a test built on that fixture
 * passed whether or not resizing worked at all. Every fixture here is a
 * PNG `sips` can genuinely open — a flat-colour bitmap with valid zlib-deflated
 * scanlines and a real CRC on every chunk — so a resize that does not run is a
 * resize that fails this file, not one it cannot see.
 *
 * @covers RT-11
 */
import { describe, test, expect } from "bun:test";
import { deflateSync, crc32 } from "node:zlib";
import { normalizeImage, MAX_IMAGE_EDGE, HARD_IMAGE_EDGE } from "./image-normalize";
import { imageShapeFromBuffer } from "../../services/image-shape";

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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(width).fill(rgb).flat())]);
  const raw = Buffer.concat(Array(height).fill(row));
  const idat = deflateSync(raw);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

const isDarwin = process.platform === "darwin";

describe("normalizeImage", () => {
  test.if(isDarwin)("un'immagine reale sopra 1568px viene DAVVERO ridimensionata, non solo dichiarata tale", () => {
    const big = realPng(3000, 2000);
    const before = imageShapeFromBuffer(big);
    expect(before).toMatchObject({ width: 3000, height: 2000 });

    const outcome = normalizeImage(big, "grande.png");
    expect(outcome.kind).toBe("image");
    if (outcome.kind !== "image") return;

    // La prova vera: si decodificano i byte DAVVERO tornati, non ci si fida
    // dell'esito dichiarato. Un fallback ai byte originali (non ridimensionati)
    // farebbe fallire proprio qui.
    const outBytes = Buffer.from(outcome.image.data, "base64");
    const afterShape = imageShapeFromBuffer(outBytes);
    expect(afterShape).not.toBeNull();
    expect(afterShape!.width).toBeLessThanOrEqual(MAX_IMAGE_EDGE);
    expect(afterShape!.height).toBeLessThanOrEqual(MAX_IMAGE_EDGE);
    expect(outcome.image.mediaType).toBe("image/jpeg");
  });

  test.if(isDarwin)("un'immagine reale già sotto il limite passa comunque per il tetto di byte (JPEG, non i byte originali)", () => {
    const small = realPng(400, 300);
    const outcome = normalizeImage(small, "piccola.png");
    expect(outcome.kind).toBe("image");
    if (outcome.kind !== "image") return;
    expect(outcome.image.mediaType).toBe("image/jpeg");
  });

  test("byte che non corrispondono a nessun formato noto: testo, non un blocco immagine rotto", () => {
    const garbage = Buffer.from("questo non è affatto un'immagine, sono solo parole"); // allow-italian: dato del test
    const outcome = normalizeImage(garbage, "misteriosa.png");
    expect(outcome.kind).toBe("text");
    if (outcome.kind !== "text") return;
    expect(outcome.text).toContain("misteriosa.png");
    expect(outcome.text.toLowerCase()).toContain("non riconosciuto");
  });

  test("un file .png che in realtà è un JPEG viene misurato e nominato per quello che è", () => {
    // SOI + un JFIF minimo + SOF0 100x80: byte JPEG veri, nessuna estensione coinvolta.
    const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14)]);
    const sof0 = Buffer.alloc(11);
    sof0[0] = 0xff; sof0[1] = 0xc0; sof0.writeUInt16BE(9, 2); sof0[4] = 8;
    sof0.writeUInt16BE(80, 5); sof0.writeUInt16BE(100, 7); sof0[9] = 3;
    const fakePngNamedJpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0]);
    const shape = imageShapeFromBuffer(fakePngNamedJpegBytes);
    expect(shape?.format).toBe("jpeg"); // il nome del file (v47.png) non è mai entrato in gioco
  });
});
