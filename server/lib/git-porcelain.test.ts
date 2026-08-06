/**
 * La stringa di prova è l'output LETTERALE di `git status --porcelain -z` su un
 * repo costruito apposta (rename + accento + untracked), catturato con
 * `tr '\0' '|'`. Non è inventata: il formato dei rename — nuovo prima, vecchio
 * dopo, in due campi — è esattamente ciò che il vecchio parse sbagliava.
 */
import { test, expect } from "bun:test";
import { parsePorcelainZ, isConflicted, scopeToPrefix } from "./git-porcelain";

// " M città.md" · "R  new.md" + "old.md" · "?? untracked.txt"
const REAL = " M città.md\0R  new.md\0old.md\0?? untracked.txt\0";

test("il path non-ASCII arriva grezzo, non ottalizzato", () => {
  const e = parsePorcelainZ(REAL);
  expect(e[0].path).toBe("città.md");
  // Senza -z sarebbe `"citt\303\240.md"`, virgolette comprese, e ogni
  // `git add --` su quella stringa risponde `fatal: pathspec`.
  expect(e[0].path).not.toContain("\\");
  expect(e[0].path).not.toContain('"');
});

test("il rename è DUE path, non una stringa con la freccia", () => {
  const e = parsePorcelainZ(REAL);
  const ren = e.find(x => x.status[0] === "R")!;
  expect(ren.path).toBe("new.md");
  expect(ren.origPath).toBe("old.md");
  // Il vecchio parse dava `old.md -> new.md` come unico path.
  expect(ren.path).not.toContain("->");
});

test("il campo del rename non viene scambiato per un record a sé", () => {
  const e = parsePorcelainZ(REAL);
  expect(e).toHaveLength(3);
  expect(e.map(x => x.path)).toEqual(["città.md", "new.md", "untracked.txt"]);
});

test("il codice XY resta grezzo a due caratteri", () => {
  const e = parsePorcelainZ(REAL);
  expect(e[0].status).toBe(" M");   // NON "M": trimmato sembrerebbe staged
  expect(e[0].status).toHaveLength(2);
  expect(e[2].status).toBe("??");
});

test("record vuoti o troncati non producono path vuoti", () => {
  expect(parsePorcelainZ("")).toEqual([]);
  expect(parsePorcelainZ("\0\0")).toEqual([]);
  // "XY " senza path: un `git add -- ""` a valle prenderebbe TUTTO.
  expect(parsePorcelainZ(" M \0")).toEqual([]);
});

test("i conflitti si riconoscono, e non sono modifiche normali", () => {
  for (const s of ["UU", "AA", "DD", "AU", "UA", "DU", "UD"]) {
    expect(isConflicted(s)).toBe(true);
  }
  for (const s of [" M", "M ", "MM", "A ", " D", "??", "R "]) {
    expect(isConflicted(s)).toBe(false);
  }
});

test("una copia porta anch'essa il path di provenienza", () => {
  const e = parsePorcelainZ("C  copia.md\0sorgente.md\0");
  expect(e).toHaveLength(1);
  expect(e[0].origPath).toBe("sorgente.md");
});

test("scoping a una sottocartella: taglia il prefisso e non inventa path", () => {
  const e = parsePorcelainZ(" M pkg/a.ts\0 M altro/b.ts\0R  pkg/new.ts\0fuori/old.ts\0");
  const s = scopeToPrefix(e, "pkg/");
  expect(s.map(x => x.path)).toEqual(["a.ts", "new.ts"]);
  // Il rename viene da FUORI dalla sottocartella: la provenienza resta intera,
  // troncarla darebbe un path che non esiste.
  expect(s[1].origPath).toBe("fuori/old.ts");
});

test("senza prefisso non si tocca niente", () => {
  const e = parsePorcelainZ(REAL);
  expect(scopeToPrefix(e, "")).toEqual(e);
});
