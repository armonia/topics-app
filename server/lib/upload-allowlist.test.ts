/**
 * I test che contano qui sono i due modi di scavalcare un'allowlist scritta
 * male: il fratello col prefisso giusto e il symlink. Un test che prova solo
 * "dentro passa, fuori no" sarebbe passato anche sulla versione sbagliata.
 *
 * @covers AUTHGATE-02
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  isInsideRoot,
  uploadAllowedRoots,
  checkUploadPath,
  parseExtraRoots,
} from "./upload-allowlist";

describe("isInsideRoot", () => {
  it("un file dentro la radice passa", () => {
    expect(isInsideRoot("/Users/x/media/a.png", "/Users/x/media")).toBe(true);
    expect(isInsideRoot("/Users/x/media/sub/a.png", "/Users/x/media")).toBe(true);
  });

  it("la radice stessa passa", () => {
    expect(isInsideRoot("/Users/x/media", "/Users/x/media")).toBe(true);
  });

  it("IL FRATELLO COL PREFISSO GIUSTO non passa", () => {
    // Questo è ciò che `startsWith(root)` nudo lascerebbe entrare: una cartella
    // diversa il cui nome comincia con quello della radice.
    expect(isInsideRoot("/Users/x/media-rubato/segreto", "/Users/x/media")).toBe(false);
    expect(isInsideRoot("/Users/x/mediaX", "/Users/x/media")).toBe(false);
  });

  it("`../` non scavalca (il path si normalizza prima del confronto)", () => {
    expect(isInsideRoot("/Users/x/media/../../../etc/passwd", "/Users/x/media")).toBe(false);
    // Un `../` che rientra è legittimo e deve passare.
    expect(isInsideRoot("/Users/x/media/sub/../a.png", "/Users/x/media")).toBe(true);
  });

  it("una radice con lo slash finale si comporta uguale", () => {
    expect(isInsideRoot("/Users/x/media/a.png", "/Users/x/media/")).toBe(true);
    expect(isInsideRoot("/Users/x/media-rubato/a.png", "/Users/x/media/")).toBe(false);
  });
});

describe("uploadAllowedRoots", () => {
  it("unisce le sorgenti, normalizza e deduplica", () => {
    const roots = uploadAllowedRoots({
      mediaDirs: ["/a/media", "/a/media"],
      uploadsDir: "/a/uploads",
      projectPaths: ["/p/uno", "/p/due/"],
      extraRoots: ["/extra"],
    });
    expect(roots).toEqual(["/a/media", "/a/uploads", "/p/uno", "/p/due", "/extra"]);
  });

  it("scarta i vuoti e la radice `/`", () => {
    // `/` come radice consentita vanificherebbe l'allowlist restando scritta:
    // sembrerebbe configurata e non filtrerebbe niente.
    expect(uploadAllowedRoots({ extraRoots: ["", "   ", "/"] })).toEqual([]);
  });
});

describe("checkUploadPath", () => {
  const roots = ["/a/media", "/p/uno"];

  it("dentro una radice: consentito", () => {
    expect(checkUploadPath("/p/uno/doc.pdf", roots)).toEqual({ ok: true });
  });

  it("fuori: rifiutato, e il messaggio dice path E radici attese", () => {
    const v = checkUploadPath("/Users/x/.ssh/id_rsa", roots);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("atteso rifiuto");
    expect(v.error).toContain("/Users/x/.ssh/id_rsa");
    expect(v.error).toContain("/a/media");
    expect(v.error).toContain("/p/uno");
  });

  it("nessuna radice configurata: si rifiuta tutto, non si consente tutto", () => {
    const v = checkUploadPath("/qualsiasi/cosa", []);
    expect(v.ok).toBe(false);
  });
});

describe("parseExtraRoots", () => {
  it("separa sui due punti e scarta i vuoti", () => {
    expect(parseExtraRoots("/a:/b")).toEqual(["/a", "/b"]);
    expect(parseExtraRoots("/a::  :/b ")).toEqual(["/a", "/b"]);
    expect(parseExtraRoots("")).toEqual([]);
    expect(parseExtraRoots(undefined)).toEqual([]);
  });
});

// Il symlink è l'unico caso che una funzione pura non può dimostrare da sola:
// serve il disco. Il contratto è che CHI CHIAMA risolve, e questo test prova
// che risolvere è ciò che chiude il buco.
describe("symlink: il confronto deve girare sul path REALE", () => {
  let tmp: string;
  let allowed: string;
  let outside: string;

  beforeAll(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "upload-allowlist-")));
    allowed = join(tmp, "consentita");
    outside = join(tmp, "fuori");
    mkdirSync(allowed);
    mkdirSync(outside);
    writeFileSync(join(outside, "segreto.txt"), "roba");
    symlinkSync(join(outside, "segreto.txt"), join(allowed, "esca.txt"));
  });

  afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("a stringa il link sembra dentro la radice", () => {
    expect(isInsideRoot(join(allowed, "esca.txt"), allowed)).toBe(true);
  });

  it("risolto, si vede che punta fuori ed è rifiutato", () => {
    const real = realpathSync(join(allowed, "esca.txt"));
    expect(checkUploadPath(real, [allowed]).ok).toBe(false);
  });

  it("un file vero dentro la radice resta consentito dopo la risoluzione", () => {
    const p = join(allowed, "vero.txt");
    writeFileSync(p, "ok");
    expect(checkUploadPath(realpathSync(p), [allowed]).ok).toBe(true);
  });
});
