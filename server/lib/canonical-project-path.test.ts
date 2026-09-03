/**
 * The folder is the project, not the road that leads to it: a link, a trailing
 * slash and `~` all name the same directory, and the id must not see them.
 *
 * @covers PROJ-ID-01
 */
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
    const vero = join(base, "vero");
    mkdirSync(vero);
    const link = join(base, "link");
    symlinkSync(vero, link);
    expect(canonicalProjectPath(link)).toBe(canonicalProjectPath(vero));
  });

  it("una cartella che non esiste ancora si tiene com'è: non è un errore", () => {
    const mai = join(base, "non-esiste");
    expect(canonicalProjectPath(mai)).toBe(mai);
  });

  it("normalizza la barra finale, che altrimenti è un secondo progetto", () => {
    const vero = join(base, "x");
    mkdirSync(vero);
    expect(canonicalProjectPath(vero + "/")).toBe(canonicalProjectPath(vero));
  });

  it("espande ~/ come fa il resto dell'app", () => {
    expect(canonicalProjectPath("~/")).toBe(realpathSync(homedir()));
  });

  it("stringa vuota resta vuota: nessun progetto, non la home", () => {
    expect(canonicalProjectPath("")).toBe("");
    expect(canonicalProjectPath(null)).toBe("");
  });
});
