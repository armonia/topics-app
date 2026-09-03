import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { canonicalProjectPath } from "./canonical-project-path";

let base: string;
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), "canon-"))); });
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("canonicalProjectPath", () => {
  it("un link e la sua cartella sono lo STESSO progetto", () => {
    const realDir = join(base, "vero");
    mkdirSync(realDir);
    const link = join(base, "link");
    symlinkSync(realDir, link);
    expect(canonicalProjectPath(link)).toBe(canonicalProjectPath(realDir));
  });

  it("una cartella che non esiste ancora si tiene com'è: non è un errore", () => {
    const missing = join(base, "non-esiste");
    expect(canonicalProjectPath(missing)).toBe(missing);
  });

  it("normalizza la barra finale, che altrimenti è un secondo progetto", () => {
    const realDir = join(base, "x");
    mkdirSync(realDir);
    expect(canonicalProjectPath(realDir + "/")).toBe(canonicalProjectPath(realDir));
  });

  it("espande ~/ come fa il resto dell'app", () => {
    expect(canonicalProjectPath("~/")).toBe(realpathSync(homedir()));
  });

  it("stringa vuota resta vuota: nessun progetto, non la home", () => {
    expect(canonicalProjectPath("")).toBe("");
    expect(canonicalProjectPath(null)).toBe("");
  });
});
