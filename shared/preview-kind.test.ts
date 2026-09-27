/**
 * The extension map the byte route and the diff panel share: which changed
 * files get a picture, which a rendered page, and which stay "binary".
 *
 * @covers DIFFPV-02, DIFFPV-05
 */
import { describe, test, expect } from "bun:test";
import { previewTypeOf } from "./preview-kind";

describe("previewTypeOf", () => {
  test("every image extension the spec names is a picture, with its MIME", () => {
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"]) {
      expect(previewTypeOf(`assets/logo.${ext}`)?.kind).toBe("image");
    }
    expect(previewTypeOf("a/b/Logo.PNG")).toEqual({ kind: "image", mime: "image/png" });
    expect(previewTypeOf("x.jpg")?.mime).toBe("image/jpeg");
  });

  test("svg and markdown have a preview of their own kind", () => {
    expect(previewTypeOf("docs/diagram.svg")).toEqual({ kind: "svg", mime: "image/svg+xml" });
    expect(previewTypeOf("README.md")?.kind).toBe("markdown");
    expect(previewTypeOf("docs/notes.markdown")?.kind).toBe("markdown");
  });

  test("other binaries and secrets are not served: PDF, font, archive, .env", () => {
    for (const p of ["doc.pdf", "font.woff2", "bundle.zip", ".env", "config/.env", "server.ts", "Makefile"]) {
      expect(previewTypeOf(p)).toBeNull();
    }
  });

  test("a dotfile named like an extension is not a picture", () => {
    expect(previewTypeOf(".png")).toBeNull();
    expect(previewTypeOf("dir.png/file")).toBeNull();
  });
});
