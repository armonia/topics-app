import { describe, expect, test } from "bun:test";
import { annunciaRipresa } from "./dead-run-note";

describe("la nota della sessione morta", () => {
  test("si scrive solo mentre la card sta ancora lavorando", () => {
    expect(annunciaRipresa("in_progress")).toBe(true);
  });

  test("una card gia' consegnata non viene 'ripresa': la frase sarebbe falsa", () => {
    for (const s of ["review", "done", "todo", "parked", "archived"]) {
      expect(`${s}→${annunciaRipresa(s)}`).toBe(`${s}→false`);
    }
  });

  test("stato sconosciuto o assente: si tace, non si indovina", () => {
    expect(annunciaRipresa(undefined)).toBe(false);
    expect(annunciaRipresa(null)).toBe(false);
    expect(annunciaRipresa("")).toBe(false);
  });
});
