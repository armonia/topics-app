/**
 * Presidio: OGNI spec E2E deve dichiarare il proprio confine ermetico.
 *
 * `hermetic(test)` è una riga che si dimentica, e dimenticarla non rompe niente
 * *in quel file*: il file eredita lo stato del precedente e passa lo stesso, per
 * mesi. Il conto arriva altrove — su una spec che, quaranta test più avanti,
 * trova un workspace che nessuno le ha mai promesso. Questo test rende quella
 * dimenticanza un rosso immediato, nel posto giusto, senza dover far girare la
 * suite E2E per accorgersene.
 *
 * Vedi tests/e2e/fixtures/hermetic.ts per il perché della chiamata esplicita.
  * @covers E2E-GATE-04
 */
import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const E2E_DIR = join(import.meta.dir, "../e2e");

function specFiles(): string[] {
  return readdirSync(E2E_DIR).filter((f) => f.endsWith(".spec.ts")).sort();
}

describe("suite E2E ermetica", () => {
  it("ha spec da controllare (se questo scende a zero, il presidio sta guardando la cartella sbagliata)", () => {
    expect(specFiles().length).toBeGreaterThan(50);
  });

  it("ogni spec chiama hermetic(<il proprio test>)", () => {
    const missing: string[] = [];
    for (const f of specFiles()) {
      const src = readFileSync(join(E2E_DIR, f), "utf8");
      if (!/^hermetic\(\s*\w+\s*\);\s*$/m.test(src)) missing.push(f);
    }
    expect(missing).toEqual([]);
  });

  it("nessuna spec importa hermetic senza poi chiamarlo", () => {
    const dead: string[] = [];
    for (const f of specFiles()) {
      const src = readFileSync(join(E2E_DIR, f), "utf8");
      const imports = /from\s*["']\.\/fixtures\/hermetic["']/.test(src);
      const calls = /^hermetic\(/m.test(src);
      if (imports !== calls) dead.push(f);
    }
    expect(dead).toEqual([]);
  });

  it("hermetic(test) sta a top-level, non dentro un describe", () => {
    // Dentro un `describe` l'hook si registra sulla suite annidata: girerebbe
    // DOPO i beforeAll del file, cancellando ciò che quelli hanno seminato.
    const nested: string[] = [];
    for (const f of specFiles()) {
      const src = readFileSync(join(E2E_DIR, f), "utf8");
      const line = src.split("\n").find((l) => /^\s*hermetic\(/.test(l));
      if (line && /^\s+/.test(line)) nested.push(f);
    }
    expect(nested).toEqual([]);
  });
});
