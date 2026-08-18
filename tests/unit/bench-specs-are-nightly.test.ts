import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const E2E = join(import.meta.dir, "..", "e2e");

/**
 * Un banco non e' un cancello, e non deve poter far cadere una PR.
 *
 * I tre `bench-*.spec.ts` MISURANO: scrivono un artefatto che `bun run bench`
 * legge. Un cancello dice si'/no su una soglia; un banco produce un numero. Se un
 * numero non esce, la risposta giusta e' «non misurato», non «la PR e' rossa».
 *
 * E non e' teorico: il 2026-08-15 `bench-ai-latency.spec.ts` e' andato in gate
 * mode perche' era l'unico dei tre a non portare `@nightly`, ci ha messo un minuto
 * per tentativo, ha ritentato due volte, e ha tinto di rosso `e2e (1)` su un
 * commit il cui contenuto non c'entrava niente. Tre minuti di runner per un
 * numero che nessuno stava leggendo.
 *
 * Il tag va su ENTRAMBI, describe e test, perche' `grepInvert` di Playwright
 * lavora sul titolo completo e in questa suite la convenzione e' gia' quella (lo
 * dice il commento in testa a `playwright.config.ts`): il describe copre il file,
 * il tag sul test protegge chi domani aggiunge un caso senza guardare in alto.
 */
function benchSpecs(): string[] {
  return readdirSync(E2E)
    .filter((n) => n.startsWith("bench-") && n.endsWith(".spec.ts"))
    .map((n) => join(E2E, n));
}

describe("i banchi restano fuori dal cancello della PR", () => {
  test("ce ne sono, altrimenti questo test non guarda niente", () => {
    // Guardia della guardia: il giorno che i banchi cambiano nome, questo test
    // smette di proteggere e deve dirlo invece di restare verde a vuoto.
    expect(benchSpecs().length).toBeGreaterThanOrEqual(3);
  });

  test("ogni describe di un banco porta @nightly", () => {
    const colpevoli: string[] = [];
    for (const f of benchSpecs()) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/test\.describe(?:\.serial|\.parallel)?\(\s*"([^"]*)"/g)) {
        if (!m[1]!.includes("@nightly")) colpevoli.push(`${f.split("/").pop()}: describe "${m[1]}"`);
      }
    }
    expect(colpevoli, "un banco senza @nightly gira nel gate della PR e la fa cadere su una MISURA").toEqual([]);
  });

  test("ogni test di un banco porta @nightly", () => {
    const colpevoli: string[] = [];
    for (const f of benchSpecs()) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/^\s*test\(\s*"([^"]*)"/gm)) {
        if (!m[1]!.includes("@nightly")) colpevoli.push(`${f.split("/").pop()}: test "${m[1]}"`);
      }
    }
    expect(colpevoli, "stesso motivo del describe, e questo copre chi aggiunge un caso senza guardare in alto").toEqual([]);
  });

  test("il tier PR esclude davvero @nightly, che e' cio' su cui poggia tutto", () => {
    const cfg = readFileSync(join(E2E, "..", "..", "playwright.config.ts"), "utf8");
    expect(cfg).toContain("grepInvert");
    expect(cfg).toMatch(/grepInvert:\s*IS_PR\s*\?\s*\/@nightly\//);
  });
});
