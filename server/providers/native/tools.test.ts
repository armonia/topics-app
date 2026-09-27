/**
 * `read_file` on an image.
 *
 * Before this file, `read_file` read EVERY file as UTF-8: on a PNG that path
 * produces garbage (bytes that are not valid text), or an error, and the
 * model never sees the image. This checks that png/jpg/jpeg/gif/webp take a
 * different branch, the image comes back in `ToolResult.images` and not in
 * the text, while any plain text file keeps working exactly as before.
  * @covers RT-11
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

const ctx = { workspace: dir };

describe("read_file su un'immagine", () => {
  test("un PNG piccolo torna come blocco immagine, non come testo", async () => {
    const bytes = pngHeader(10, 10);
    put("a.png", bytes);
    const r = await executeTool("read_file", { path: "a.png" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.images).toBeDefined();
    expect(r.images![0]!.mediaType).toBe("image/png");
    // Not resized (under the limit): the bytes come back identical.
    expect(r.images![0]!.data).toBe(bytes.toString("base64"));
    expect(r.content).toContain("a.png");
    expect(r.content).toContain("10x10");
  });

  for (const [ext, mediaType] of [
    [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".gif", "image/gif"], [".webp", "image/webp"],
  ] as const) {
    test(`l'estensione ${ext} si riconosce come ${mediaType}`, async () => {
      const bytes = Buffer.from("dati finti, l'estensione basta a decidere il ramo");
      put(`b${ext}`, bytes);
      const r = await executeTool("read_file", { path: `b${ext}` }, ctx);
      expect(r.images).toBeDefined();
      expect(r.images![0]!.mediaType).toBe(mediaType);
    });
  }

  test("un'immagine più grande del limite tenta comunque il ramo immagine, non quello di testo", async () => {
    // The header declares 3000x3000: above MAX_IMAGE_EDGE (1568), so a resize
    // via `sips` is attempted. The file has no real data past the header, so
    // `sips` fails to decode it and the code falls back to the original
    // bytes, exactly the "best effort" behavior expected when the resize
    // does not work: no exception, the image still arrives.
    const bytes = pngHeader(3000, 3000);
    put("big.png", bytes);
    const r = await executeTool("read_file", { path: "big.png" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.images).toBeDefined();
    expect(r.content).toContain("3000x3000");
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
