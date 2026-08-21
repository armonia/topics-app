import { describe, expect, test } from "bun:test";
import { shouldAnnounceResume } from "./dead-run-note";

describe("la nota della sessione morta", () => {
  test("si scrive solo mentre la card sta ancora lavorando", () => {
    expect(shouldAnnounceResume("in_progress")).toBe(true);
  });

  test("una card gia' consegnata non viene 'ripresa': la frase sarebbe falsa", () => {
    for (const s of ["review", "done", "todo", "parked", "archived"]) {
      expect(`${s}→${shouldAnnounceResume(s)}`).toBe(`${s}→false`);
    }
  });

  test("stato sconosciuto o assente: si tace, non si indovina", () => {
    expect(shouldAnnounceResume(undefined)).toBe(false);
    expect(shouldAnnounceResume(null)).toBe(false);
    expect(shouldAnnounceResume("")).toBe(false);
  });
});
