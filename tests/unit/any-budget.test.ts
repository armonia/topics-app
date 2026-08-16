/**
 * IL TETTO SUGLI `any`, provato nei due versi.
 *
 * Un cricchetto ha un solo modo di rompersi in silenzio: contare zero. Se
 * `git ls-files` cambia forma, se la regex smette di prendere, se i file
 * finiscono filtrati via, il totale scende a 0, il confronto col tetto passa e
 * il cancello diventa una decorazione che dice OK per sempre. Per questo qui si
 * verifica anche che stia MISURANDO qualcosa, non solo che sia verde.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { countAny, trackedFiles, verdict } from "../../scripts/check-any-budget";

const ROOT = resolve(import.meta.dir, "../..");
const budget = JSON.parse(readFileSync(resolve(ROOT, "scripts/any-budget.json"), "utf8")) as {
  max: number;
  measured: number;
};

describe("check:any-budget — il cricchetto sugli any", () => {
  it("conta un `any` scritto in codice", () => {
    expect(countAny("function f(x: any) {}")).toBe(1);
    expect(countAny("const a = b as any;")).toBe(1);
    expect(countAny("let xs: any[] = [];")).toBe(1);
  });

  it("NON conta `any` dentro una parola: `many`, `company`, `anyone`", () => {
    // Il difetto classico di un grep ingenuo: `Company` e `many` compaiono
    // ovunque, e un cancello che li conta e' rumore da spegnere subito.
    expect(countAny("const many = companies.filter(anyone);")).toBe(0);
    expect(countAny("type Company = { anyway: string };")).toBe(0);
  });

  it("NON conta `any` nei commenti, di riga o di blocco", () => {
    expect(countAny("// qui ci sarebbe un any")).toBe(0);
    expect(countAny("/* un any dentro un blocco */")).toBe(0);
    expect(countAny("const x = 1; // era any prima")).toBe(0);
  });

  it("un `any` con la sua ragione scritta non conta", () => {
    // `allow-any:` non e' un modo per zittire il gate: e' una riga che qualcuno
    // legge in review, ed e' tutto il suo valore.
    expect(countAny("const x: any = raw; // allow-any: la risposta e' JSON libero")).toBe(0);
    // Senza ragione, conta.
    expect(countAny("const x: any = raw;")).toBe(1);
  });

  it("i block comment non spostano il conto delle righe successive", () => {
    const src = "/*\n molte righe\n di commento\n*/\nconst x: any = 1;";
    expect(countAny(src)).toBe(1);
  });

  it("verdict: sale = rosso, uguale = ok, scende = ok", () => {
    expect(verdict(371, 370)).toBe("over");
    expect(verdict(370, 370)).toBe("ok");
    expect(verdict(369, 370)).toBe("shrunk");
  });

  it("misura file VERI, e sono tanti (guardia contro il verde a vuoto)", () => {
    // Se questa lista si svuotasse, il totale sarebbe 0 e il tetto passerebbe
    // sempre: il modo piu' comune in cui un cancello smette di guardare senza
    // che nessuno se ne accorga.
    const files = trackedFiles(ROOT);
    expect(files.length).toBeGreaterThan(200);
    expect(files.every((f) => !f.endsWith(".test.ts"))).toBe(true);
  });

  it("il totale di oggi non supera il tetto scritto", () => {
    const total = trackedFiles(ROOT).reduce(
      (n, f) => n + countAny(readFileSync(resolve(ROOT, f), "utf8")),
      0,
    );
    expect(total).toBeLessThanOrEqual(budget.max);
    // E il tetto non e' un numero inventato: deve essere una misura presa.
    expect(budget.max).toBe(budget.measured);
    // Un tetto a zero con 370 `any` in giro vorrebbe dire che il conteggio si e'
    // rotto, non che il repo si e' pulito.
    expect(budget.max).toBeGreaterThan(0);
  });
});
