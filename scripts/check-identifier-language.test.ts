/**
 * The gate that would have caught the four names, and the reason the obvious
 * repair would not have.
 *
 * `check:comment-language` recognises Italian by matching 85 stopwords, and six
 * of the eight tokens in `sostituisce`, `annunciaRipresa`, `NOTA_SESSIONE_MORTA`  allow-italian: the Italian names ARE the subject
 * and `PREFISSO_NOTA_ANTEPRIMA` are not on that list. So the first test here is  allow-italian: the Italian names ARE the subject
 * not decoration: it is the proof that asking "is this English?" answers a
 * question the other phrasing could not.
  * @covers GATE-03
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { declaredNames, isKnown, words, PROJECT_WORDS } from "./check-identifier-language";

const DICT = "/usr/share/dict/words";
const dict = new Set<string>(
  existsSync(DICT) ? readFileSync(DICT, "utf8").split("\n").map((w) => w.trim().toLowerCase()).filter(Boolean) : [],
);
const hasDict = dict.size > 1000;

describe("spezzare un nome in parole", () => {
  test("camelCase, PascalCase, SCREAMING_SNAKE", () => {
    expect(words("annunciaRipresa")).toEqual(["annuncia", "ripresa"]);
    expect(words("NOTA_SESSIONE_MORTA")).toEqual(["nota", "sessione", "morta"]);
    expect(words("shouldAnnounceResume")).toEqual(["should", "announce", "resume"]);
  });

  test("le sigle corte non contano: `ctx`, `id`, `ms` non sono parole da giudicare", () => {
    expect(words("ctxId")).toEqual(["ctx"]);
  });
});

describe("le dichiarazioni, non ogni occorrenza", () => {
  test("prende const, function, interface, type", () => {
    const src = [
      "const replaces = 1;",
      "function shouldAnnounceResume() {}",
      "interface PreviewWorktree {}",
      "type Verdict = string;",
    ].join("\n");
    expect(declaredNames(src).map((d) => d.name)).toEqual([
      "replaces", "shouldAnnounceResume", "PreviewWorktree", "Verdict",
    ]);
  });

  test("una dichiarazione dentro un commento non e' una dichiarazione", () => {
    expect(declaredNames("// const sostituisce = 1;\n * const anteprima = 2;")).toEqual([]);
  });
});

describe.if(hasDict)("il giudizio", () => {
  test("i quattro nomi di quella sera sarebbero stati rossi", () => {
    for (const nome of ["sostituisce", "annunciaRipresa", "NOTA_SESSIONE_MORTA", "PREFISSO_NOTA_ANTEPRIMA"]) {
      const unknownWords = words(nome).filter((w) => !isKnown(w, dict));
      expect(`${nome}→${unknownWords.length > 0}`).toBe(`${nome}→true`);
    }
  });

  test("i nomi con cui li ho sostituiti sono verdi", () => {
    for (const nome of ["replaces", "shouldAnnounceResume", "DEAD_SESSION_NOTE", "PREVIEW_NOTE_PREFIX", "chipKey"]) {
      const unknownWords = words(nome).filter((w) => !isKnown(w, dict));
      expect(`${nome}→${unknownWords.join(",")}`).toBe(`${nome}→`);
    }
  });

  test("plurali e terze persone dell'inglese passano senza doverli elencare", () => {
    for (const w of ["replaces", "removed", "pending", "writer"]) expect(isKnown(w, dict)).toBe(true);
  });

  test("il vocabolario di progetto copre le parole che nessun dizionario ha", () => {
    for (const w of ["worktree", "dedupe", "topics", "tauri"]) {
      expect(`${w}→${isKnown(w, dict)}`).toBe(`${w}→true`);
      expect(PROJECT_WORDS.has(w)).toBe(true);
    }
  });
});
