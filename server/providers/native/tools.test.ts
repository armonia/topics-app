/**
 * `read_file` on an image.
 *
 * Before this file, `read_file` read EVERY file as UTF-8: on a PNG that path
 * produces garbage (bytes that are not valid text), or an error, and the
 * model never sees the image. This checks that a real raster file takes a
 * different branch, the image comes back in `ToolResult.images` and not in
 * the text, while any plain text file keeps working exactly as before.
 *
 * WHY NO EXTENSION HERE. The format is read from the bytes (`image-shape.ts`),
 * never from the file name — a `.png` that is really a JPEG (measured: 13 of
 * 568 files under a real Darkroom export) must be labelled JPEG regardless of
 * what it is called, or the API rejects it on a media-type mismatch on every
 * later turn.
 *
 * @covers RT-11
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { executeTool } from "./tools";

const dir = mkdtempSync(join(tmpdir(), "tools-image-"));
function put(name: string, bytes: Buffer | string): string {
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
}

/** A valid PNG header (signature + IHDR): enough for `imageShape`, and `read_file` needs even less. */
function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
  b[24] = 8; b[25] = 6;
  return b;
}

/** SOI + a minimal JFIF + SOF0: real JPEG bytes, no extension involved. */
function jpegHeader(width: number, height: number): Buffer {
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14)]);
  const sof0 = Buffer.alloc(11);
  sof0[0] = 0xff; sof0[1] = 0xc0; sof0.writeUInt16BE(9, 2); sof0[4] = 8;
  sof0.writeUInt16BE(height, 5); sof0.writeUInt16BE(width, 7); sof0[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0]);
}

const ctx = { workspace: dir };

describe("read_file su un'immagine", () => {
  test("un PNG piccolo torna come blocco immagine, non come testo", async () => {
    const bytes = pngHeader(10, 10);
    put("a.png", bytes);
    const r = await executeTool("read_file", { path: "a.png" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.images).toBeDefined();
    expect(r.images![0]!.mediaType).toBe("image/png");
    expect(r.images![0]!.data).toBe(bytes.toString("base64"));
    expect(r.content).toContain("a.png");
    expect(r.content).toContain("10x10");
  });

  test("un file .png che è in realtà un JPEG si etichetta per quello che è, non per il nome", async () => {
    const bytes = jpegHeader(100, 80);
    put("v47.png", bytes);
    const r = await executeTool("read_file", { path: "v47.png" }, ctx);
    expect(r.images).toBeDefined();
    expect(r.images![0]!.mediaType).toBe("image/jpeg");
  });

  test("un file di testo non passa dal ramo immagine: comportamento invariato", async () => {
    put("c.ts", "const x = 1;\nconst y = 2;\n");
    const r = await executeTool("read_file", { path: "c.ts" }, ctx);
    expect(r.images).toBeUndefined();
    expect(r.content).toContain("const x = 1;");
    // The usual format: line number, tab, content.
    expect(r.content).toMatch(/^\s*1\t/);
  });

  test("un file inesistente resta un errore, immagine o no", async () => {
    const r = await executeTool("read_file", { path: "non-esiste.png" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.images).toBeUndefined();
  });
});

describe("read_file, percorsi fuori dalla workspace (RT-11 finding #4)", () => {
  const outsideDir = mkdtempSync(join(tmpdir(), "tools-outside-"));

  test("un file di testo fuori dalla workspace resta bloccato", async () => {
    writeFileSync(join(outsideDir, "segreto.txt"), "no");
    const r = await executeTool("read_file", { path: join(outsideDir, "segreto.txt") }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("fuori dalla workspace");
  });

  test("un'immagine fuori dalla workspace SI legge: il perimetro vale per toccare, non per guardare", async () => {
    const bytes = pngHeader(20, 20);
    writeFileSync(join(outsideDir, "foto.png"), bytes);
    const r = await executeTool("read_file", { path: join(outsideDir, "foto.png") }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.images).toBeDefined();
    expect(r.images![0]!.mediaType).toBe("image/png");
  });

  test("un percorso con `~/` in testa si espande verso la home prima di essere risolto", async () => {
    // No real file under ~ is needed: it is enough for the error to name the
    // EXPANDED path ("home/.../inesistente.png") and not the literal tilde,
    // proving the expansion happened before the existence check.
    const r = await executeTool("read_file", { path: "~/topics-rt11-inesistente.png" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain(homedir());
    expect(r.content).not.toContain("~/");
  });
});

/**
 * JPEG bytes whose SOF sits past the 64 KB `image-shape.ts` reads first: two
 * APP1 segments of 40 KB each before it, the shape of a camera or Photoshop
 * export that carries a large EXIF/XMP block.
 */
function jpegWithLargeMetadata(width: number, height: number): Buffer {
  const app1 = () => {
    const seg = Buffer.alloc(4 + 40_000 - 2);
    seg[0] = 0xff; seg[1] = 0xe1; seg.writeUInt16BE(40_000, 2);
    return seg;
  };
  const sof0 = Buffer.alloc(11);
  sof0[0] = 0xff; sof0[1] = 0xc0; sof0.writeUInt16BE(9, 2); sof0[4] = 8;
  sof0.writeUInt16BE(height, 5); sof0.writeUInt16BE(width, 7); sof0[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1(), app1(), sof0, Buffer.from([0xff, 0xd9])]);
}

describe("read_file outside the workspace: only a raster image, only as an image", () => {
  const outsideDir = mkdtempSync(join(tmpdir(), "tools-perimeter-"));

  // The bypass as measured from the Darkroom workspace: a source file whose
  // first 64 KB hold an `<svg width=.. height=..>` literal was detected as an
  // image and handed back as numbered TEXT, from anywhere on the disk.
  test("a text file that contains an <svg> tag stays refused, and none of its text comes back", async () => {
    const secret = "const token = \"do-not-leak\";\nconst icon = '<svg width=\"16\" height=\"16\"></svg>';\n";
    writeFileSync(join(outsideDir, "icon.test.ts"), secret);
    const r = await executeTool("read_file", { path: join(outsideDir, "icon.test.ts") }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("fuori dalla workspace");
    expect(r.content).not.toContain("do-not-leak");
    expect(r.images).toBeUndefined();
  });

  test("a real SVG file outside the workspace stays refused: a vector image is text, and text outside is off limits", async () => {
    writeFileSync(join(outsideDir, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect/></svg>');
    const r = await executeTool("read_file", { path: join(outsideDir, "logo.svg") }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("fuori dalla workspace");
    expect(r.content).not.toContain("<rect");
  });

  test("an SVG inside the workspace is still read as text, like any other source file", async () => {
    put("inside.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect/></svg>');
    const r = await executeTool("read_file", { path: "inside.svg" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.images).toBeUndefined();
    expect(r.content).toContain("<rect/>");
  });

  test("a mistyped image path outside the workspace answers not found, not outside the workspace", async () => {
    const r = await executeTool("read_file", { path: join(outsideDir, "RAW", "ChatGPT Image Aug 15, 2026, 11_25_32 AM.png") }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("non trovato");
    expect(r.content).not.toContain("fuori dalla workspace");
  });

  test("a JPEG whose EXIF pushes the size past the first 64 KB is still read as an image", async () => {
    const bytes = jpegWithLargeMetadata(1200, 800);
    writeFileSync(join(outsideDir, "camera.jpg"), bytes);
    const r = await executeTool("read_file", { path: join(outsideDir, "camera.jpg") }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.images?.[0]?.mediaType).toBe("image/jpeg");
    expect(r.content).toContain("1200x800");
  });
});
