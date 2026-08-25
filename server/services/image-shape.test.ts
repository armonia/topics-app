/**
 * `imageShape` — larghezza/altezza dall'header, e il null quando non si sa.
 *
 * I fixture sono costruiti byte per byte: il parser legge SOLO l'header, quindi
 * un header vero è un caso di prova vero. In coda c'è la controprova sul
 * campo — le PNG vere del repo, confrontate con `sips`.
  * @covers MEDIA-03
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageShape } from "./image-shape";

const dir = mkdtempSync(join(tmpdir(), "image-shape-"));
function put(name: string, bytes: Buffer | string): string {
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
}

/** Header PNG: firma a 8 byte + chunk IHDR (che per specifica è il primo). */
function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
  b[24] = 8; b[25] = 6; // bit depth 8, RGBA
  return b;
}

describe("imageShape", () => {
  test("PNG: larghezza e altezza dall'IHDR", () => {
    const s = imageShape(put("a.png", pngHeader(1440, 900)));
    expect(s).toEqual({ width: 1440, height: 900, ratio: 900 / 1440 });
  });

  test("GIF: little-endian, non big-endian (è l'errore classico)", () => {
    const b = Buffer.alloc(13);
    b.write("GIF89a", 0, "latin1");
    b.writeUInt16LE(320, 6); b.writeUInt16LE(240, 8);
    expect(imageShape(put("a.gif", b))).toMatchObject({ width: 320, height: 240 });
  });

  test("JPEG: salta i segmenti fino al SOF0, e NON scambia w con h", () => {
    // SOI + APP0/JFIF (un segmento da saltare) + SOF0 con h=768, w=1024.
    const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14)]);
    const sof0 = Buffer.alloc(11);
    sof0[0] = 0xff; sof0[1] = 0xc0; sof0.writeUInt16BE(9, 2); sof0[4] = 8;
    sof0.writeUInt16BE(768, 5); sof0.writeUInt16BE(1024, 7); sof0[9] = 3;
    const b = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0]);
    expect(imageShape(put("a.jpg", b))).toMatchObject({ width: 1024, height: 768 });
  });

  test("JPEG: 0xC4 è una tabella di Huffman, non un SOF (misura sbagliata se lo si tratta da SOF)", () => {
    const dht = Buffer.alloc(20); dht[0] = 0xff; dht[1] = 0xc4; dht.writeUInt16BE(18, 2);
    const sof2 = Buffer.alloc(11);
    sof2[0] = 0xff; sof2[1] = 0xc2; sof2.writeUInt16BE(9, 2); sof2[4] = 8;
    sof2.writeUInt16BE(100, 5); sof2.writeUInt16BE(200, 7); sof2[9] = 3;
    const b = Buffer.concat([Buffer.from([0xff, 0xd8]), dht, sof2]);
    expect(imageShape(put("b.jpg", b))).toMatchObject({ width: 200, height: 100 });
  });

  test("WebP VP8X: canvas su 24 bit, memorizzato come dimensione-1", () => {
    const b = Buffer.alloc(30);
    b.write("RIFF", 0, "latin1"); b.write("WEBP", 8, "latin1"); b.write("VP8X", 12, "latin1");
    const w = 800 - 1, h = 600 - 1;
    b[24] = w & 0xff; b[25] = (w >> 8) & 0xff; b[26] = (w >> 16) & 0xff;
    b[27] = h & 0xff; b[28] = (h >> 8) & 0xff; b[29] = (h >> 16) & 0xff;
    expect(imageShape(put("a.webp", b))).toMatchObject({ width: 800, height: 600 });
  });

  test("SVG: width/height espliciti", () => {
    expect(imageShape(put("a.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="420"></svg>')))
      .toMatchObject({ width: 900, height: 420 });
  });

  test("SVG senza width/height: la forma la dà il viewBox (il caso NORMALE di un diagramma esportato)", () => {
    const s = imageShape(put("b.svg", '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 500"><rect/></svg>'));
    expect(s).toMatchObject({ width: 1000, height: 500 });
    expect(s!.ratio).toBe(0.5);
  });

  test("il formato esce dai BYTE, non dall'estensione: un .png che è un GIF si misura lo stesso", () => {
    const b = Buffer.alloc(13);
    b.write("GIF89a", 0, "latin1"); b.writeUInt16LE(64, 6); b.writeUInt16LE(64, 8);
    expect(imageShape(put("bugiardo.png", b))).toMatchObject({ width: 64, height: 64 });
  });

  test("in dubbio, null: file assente, formato ignoto, dimensioni a zero", () => {
    expect(imageShape(join(dir, "non-esiste.png"))).toBeNull();
    expect(imageShape(put("a.mp4", Buffer.alloc(64)))).toBeNull();
    expect(imageShape(put("vuoto.png", Buffer.alloc(0)))).toBeNull();
    expect(imageShape(put("zero.png", pngHeader(0, 100)))).toBeNull();
    expect(imageShape(put("testo.svg", "questo non è un svg"))).toBeNull();
  });
});
