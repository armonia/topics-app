/**
 * The room under the last card is DERIVED from what covers the column, not
 * copied into a constant. The rendered proof is
 * `tests/e2e/board-mobile-phone.spec.ts`; this pins the arithmetic and the one
 * reader of the variable.
 *
 * @covers KANBAN-MOBILE-04
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BOARD_BOTTOM_CLEAR_VAR, CLEARANCE_GAP_PX, bottomClearance } from "./columnClearance";

describe("bottomClearance", () => {
  test("il fondo coperto dal composer piu' il respiro", () => {
    // Measured on a 390x844 phone: column body bottom 831, composer top 690.
    expect(bottomClearance(831, 690)).toBe(141 + CLEARANCE_GAP_PX);
  });

  test("un composer piu' alto chiede piu' spazio, non lo stesso", () => {
    expect(bottomClearance(831, 640)).toBeGreaterThan(bottomClearance(831, 690));
  });

  test("niente composer (nascosto): resta il solo respiro, la banda la aggiunge il CSS", () => {
    expect(bottomClearance(831, null)).toBe(CLEARANCE_GAP_PX);
  });

  test("un composer che non entra nella colonna non sottrae niente", () => {
    expect(bottomClearance(500, 700)).toBe(CLEARANCE_GAP_PX);
  });

  test("mai un mezzo pixel: si arrotonda per eccesso", () => {
    expect(bottomClearance(831.4, 690)).toBe(158);
  });
});

describe("il corpo colonna legge la misura", () => {
  const CARD = readFileSync(join(import.meta.dir, "Card.tsx"), "utf8");

  test("il padding del corpo colonna e' la variabile, non un numero fisso", () => {
    const body = CARD.slice(CARD.indexOf("data-testid={`kanban-column-body-${status}`}"));
    const tag = body.slice(0, body.indexOf(">"));
    expect(tag).toContain(`var(${BOARD_BOTTOM_CLEAR_VAR}`);
    expect(tag, "il pavimento sul telefono e' la banda dei tasti").toContain("var(--mobile-band-own-h");
    expect(tag, "il vecchio pb-36 fisso e' tornato").not.toMatch(/\bpb-36\b/);
  });
});
