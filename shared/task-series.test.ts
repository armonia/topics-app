/**
 * @covers KANBAN-08
 * Which titles say "I am one of a numbered series": the two shapes the agents write, and the lookalikes
 * (dates, a lone number, a title with no prefix) that must not be grouped.
 */
import { describe, expect, test } from "bun:test";
import { areSiblingsInSeries, isSeriesName, normalizeSeriesPrefix, parseTaskSeries } from "./task-series";

describe("parseTaskSeries: the fraction schema", () => {
  test("«Lavori programmati 3/8: consegna ...» is member 3/8 of «Lavori programmati»", () => {
    const s = parseTaskSeries("Lavori programmati 3/8: consegna dei report");
    expect(s).toMatchObject({ prefix: "Lavori programmati", schema: "fraction", counter: "3/8" });
  });

  test("the prefix is the text before the counter, with trailing spaces and colons removed", () => {
    expect(parseTaskSeries("Due repo:  1/3 setup")!.prefix).toBe("Due repo");
    expect(parseTaskSeries("Patto Armonia   2/5")!.prefix).toBe("Patto Armonia");
  });

  test("the counter may end the title, or be followed by a colon, a dash or a comma", () => {
    for (const t of ["Migrazione 2/4", "Migrazione 2/4: dati", "Migrazione 2/4 - dati", "Migrazione 2/4, dati", "Migrazione 2/4 \u2014 dati"]) {
      expect(parseTaskSeries(t)?.counter).toBe("2/4");
    }
  });

  test("N must not exceed M and M must be at least 2: «12/11» is a date, «24/7» a schedule, «1/1» one card", () => {
    expect(parseTaskSeries("Riunione 12/11 con il cliente")).toBeNull();
    expect(parseTaskSeries("Monitoraggio 24/7 dei nodi")).toBeNull();
    expect(parseTaskSeries("Cartella 1/1")).toBeNull();
    expect(parseTaskSeries("Cartella 0/4")).toBeNull();
  });

  test("a counter glued to letters is not a counter", () => {
    expect(parseTaskSeries("Versione 3/8x stabile")).toBeNull();
  });
});

describe("parseTaskSeries: the tag schema", () => {
  test("«Due repo T5: hub generico ...» is member T5 of «Due repo»", () => {
    const s = parseTaskSeries("Due repo T5: hub generico per gli agenti");
    expect(s).toMatchObject({ prefix: "Due repo", schema: "tag", counter: "T5" });
  });

  test("only a capital T with digits counts: «Test 5», «T5b» and «task 5» are not tags", () => {
    expect(parseTaskSeries("Prova Test 5 del cancello")).toBeNull();
    expect(parseTaskSeries("Due repo T5b: hub")).toBeNull();
    expect(parseTaskSeries("Due repo t5: hub")).toBeNull();
  });
});

describe("parseTaskSeries: what is not a series", () => {
  test("no prefix, a prefix with no letters, a plain title, nothing", () => {
    expect(parseTaskSeries("3/8: consegna")).toBeNull();
    expect(parseTaskSeries("12 3/8 consegna")).toBeNull();
    expect(parseTaskSeries("Aggiorna il cancello dei doppioni")).toBeNull();
    expect(parseTaskSeries("")).toBeNull();
    expect(parseTaskSeries(null)).toBeNull();
    expect(parseTaskSeries(undefined)).toBeNull();
  });
});

describe("the identity of a series", () => {
  test("the same prefix and schema give the same key, whatever the case, accents or spacing", () => {
    const a = parseTaskSeries("Lavori programmati 3/8: a")!;
    const b = parseTaskSeries("lavori  PROGRAMMATI 4/8 b")!;
    expect(a.key).toBe(b.key);
    expect(parseTaskSeries("Perché 1/3")!.key).toBe(parseTaskSeries("Perche 2/3")!.key);
  });

  test("the schema is part of the key: «Due repo 1/3» and «Due repo T1» are two series", () => {
    expect(parseTaskSeries("Due repo 1/3 x")!.key).not.toBe(parseTaskSeries("Due repo T1 x")!.key);
  });

  test("another prefix is another series", () => {
    expect(parseTaskSeries("Lavori programmati 3/8")!.key).not.toBe(parseTaskSeries("Lavori urgenti 3/8")!.key);
  });

  test("normalizeSeriesPrefix drops case, accents, trailing colons and runs of spaces", () => {
    expect(normalizeSeriesPrefix("  Più   Lavori: ")).toBe("piu lavori");
  });
});

describe("siblings and the name of the series", () => {
  test("two members of one series are siblings, however alike the rest of the title is", () => {
    expect(areSiblingsInSeries("Due repo T5: hub generico", "Due repo T6: hub generico")).toBe(true);
    expect(areSiblingsInSeries("Lavori programmati 3/8: consegna", "Lavori programmati 4/8: consegna")).toBe(true);
  });

  test("the same member twice is not a pair of siblings: that is a duplicate", () => {
    expect(areSiblingsInSeries("Due repo T5: hub generico", "Due repo T5: hub generico per gli agenti")).toBe(false);
  });

  test("members of different series, or a title that is no member, are not siblings", () => {
    expect(areSiblingsInSeries("Due repo T5: hub", "Altro lavoro T6: hub")).toBe(false);
    expect(areSiblingsInSeries("Due repo T5: hub", "Aggiornare il hub")).toBe(false);
  });

  test("the card that names the series is the prefix with no counter", () => {
    const series = parseTaskSeries("Lavori programmati 3/8: consegna")!;
    expect(isSeriesName("Lavori programmati", series)).toBe(true);
    expect(isSeriesName("lavori programmati:", series)).toBe(true);
    expect(isSeriesName("Lavori programmati 4/8: consegna", series)).toBe(false);
    expect(isSeriesName("Lavori urgenti", series)).toBe(false);
  });
});
