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
import { normalizeImage, MAX_IMAGE_EDGE } from "./image-normalize";
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
  test.if(isDarwin)("un'immagine reale sopra 1568px viene DAVVERO ridimensionata, non solo dichiarata tale", async () => {
    const big = realPng(3000, 2000);
    const before = imageShapeFromBuffer(big);
    expect(before).toMatchObject({ width: 3000, height: 2000 });

    const outcome = await normalizeImage(big, "grande.png");
    expect(outcome.kind).toBe("image");
    if (outcome.kind !== "image") return;

    // The real proof: decode the bytes ACTUALLY returned, do not trust the
    // reported outcome. A fallback to the original (unresized) bytes would
    // fail right here.
    const outBytes = Buffer.from(outcome.image.data, "base64");
    const afterShape = imageShapeFromBuffer(outBytes);
    expect(afterShape).not.toBeNull();
    expect(afterShape!.width).toBeLessThanOrEqual(MAX_IMAGE_EDGE);
    expect(afterShape!.height).toBeLessThanOrEqual(MAX_IMAGE_EDGE);
    expect(outcome.image.mediaType).toBe("image/jpeg");
  });

  test.if(isDarwin)("un'immagine reale già sotto il limite passa comunque per il tetto di byte (JPEG, non i byte originali)", async () => {
    const small = realPng(400, 300);
    const outcome = await normalizeImage(small, "piccola.png");
    expect(outcome.kind).toBe("image");
    if (outcome.kind !== "image") return;
    expect(outcome.image.mediaType).toBe("image/jpeg");
  });

  test("byte che non corrispondono a nessun formato noto: testo, non un blocco immagine rotto", async () => {
    const garbage = Buffer.from("questo non è affatto un'immagine, sono solo parole"); // allow-italian: dato del test
    const outcome = await normalizeImage(garbage, "misteriosa.png");
    expect(outcome.kind).toBe("text");
    if (outcome.kind !== "text") return;
    expect(outcome.text).toContain("misteriosa.png");
    expect(outcome.text.toLowerCase()).toContain("non riconosciuto");
  });

  test("un file .png che in realtà è un JPEG viene misurato e nominato per quello che è", () => {
    // SOI + a minimal JFIF + SOF0 100x80: real JPEG bytes, no extension involved.
    const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14)]);
    const sof0 = Buffer.alloc(11);
    sof0[0] = 0xff; sof0[1] = 0xc0; sof0.writeUInt16BE(9, 2); sof0[4] = 8;
    sof0.writeUInt16BE(80, 5); sof0.writeUInt16BE(100, 7); sof0[9] = 3;
    const fakePngNamedJpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0]);
    const shape = imageShapeFromBuffer(fakePngNamedJpegBytes);
    expect(shape?.format).toBe("jpeg"); // the file name (v47.png) never came into it
  });
});

/** A valid PNG header only: enough for the shape, nothing a decoder could open. */
function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
  b[24] = 8; b[25] = 6;
  return b;
}

describe("normalizeImage never enlarges a picture", () => {
  // Measured on the rework: `sips -Z 1568` scales UP as well as down, so a
  // 64x64 icon went out as 1568x1568 and a 400x300 crop as 1568x1176, paying
  // for pixels that were never there.
  test.if(isDarwin)("a 64x64 image stays 64x64", async () => {
    const outcome = await normalizeImage(realPng(64, 64), "icona.png");
    expect(outcome.kind).toBe("image");
    if (outcome.kind !== "image") return;
    expect(imageShapeFromBuffer(Buffer.from(outcome.image.data, "base64"))).toMatchObject({ width: 64, height: 64 });
  });

  test.if(isDarwin)("a 400x300 image stays 400x300", async () => {
    const outcome = await normalizeImage(realPng(400, 300), "ritaglio.png");
    expect(outcome.kind).toBe("image");
    if (outcome.kind !== "image") return;
    expect(imageShapeFromBuffer(Buffer.from(outcome.image.data, "base64"))).toMatchObject({ width: 400, height: 300 });
  });
});

describe("normalizeImage does not hold the event loop while sips runs", () => {
  // `spawnSync` stopped the whole server for the length of every resize
  // (104 ms on a 1254px Darkroom render, 209 ms on a 6000x4000): no socket,
  // no timer, no other chat moved meanwhile.
  test.if(isDarwin)("a timer keeps firing while a large image is being resized", async () => {
    const big = realPng(3000, 2000);
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    try {
      const outcome = await normalizeImage(big, "grande.png");
      expect(outcome.kind).toBe("image");
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
  });
});

describe("an SVG never becomes an image block", () => {
  // The API takes png, jpeg, gif and webp only: an `image/svg+xml` block from
  // an MCP server was a 400 that took every image out of the history with it.
  test("an SVG comes back as text that carries its markup, on every platform", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><text>Topics</text></svg>');
    const outcome = await normalizeImage(svg, "mcp__design__logo");
    expect(outcome.kind).toBe("text");
    if (outcome.kind !== "text") return;
    expect(outcome.text).toContain("mcp__design__logo");
    expect(outcome.text).toContain("<text>Topics</text>");
  });
});

describe("without sips (Windows, Linux) an image already within the limits goes out as it is", () => {
  test("a small PNG passes as a PNG, byte for byte, with no resize", async () => {
    const small = realPng(40, 30);
    const outcome = await normalizeImage(small, "shot.png", "linux");
    expect(outcome.kind).toBe("image");
    if (outcome.kind !== "image") return;
    expect(outcome.image.mediaType).toBe("image/png");
    expect(outcome.image.data).toBe(small.toString("base64"));
  });

  test("an image over the pixel cap becomes text naming the file and its size", async () => {
    const outcome = await normalizeImage(pngHeader(3000, 2000), "RAW/foto grande.png", "win32");
    expect(outcome.kind).toBe("text");
    if (outcome.kind !== "text") return;
    expect(outcome.text).toContain("RAW/foto grande.png");
    expect(outcome.text).toContain("3000x2000");
  });

  test("an image within the pixel cap but over the byte cap becomes text as well", async () => {
    const heavy = Buffer.concat([pngHeader(1000, 1000), Buffer.alloc(4 * 1024 * 1024)]);
    const outcome = await normalizeImage(heavy, "pesante.png", "linux");
    expect(outcome.kind).toBe("text");
    if (outcome.kind !== "text") return;
    expect(outcome.text).toContain("pesante.png");
  });
});
