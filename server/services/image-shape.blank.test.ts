/**
 * The floor between "blank" and "a screenshot", held with the real numbers.
 *
 * These are not invented: they are the byte-per-pixel densities of every PNG
 * preview on this machine on 2026-08-21. The blank one sits five times below
 * the lightest real one, and the test exists so a future change to the floor
 * has to argue with the measurement instead of with an opinion.
 */
import { describe, expect, test } from "bun:test";
import { BLANK_DENSITY_FLOOR, isBlankLikeImage } from "./image-shape";

const px = (w: number, h: number) => w * h;

describe("un'immagine che non mostra niente", () => {
  test("la bianca vera, misurata: 4257 byte per 1280x720", () => {
    expect(isBlankLikeImage({ bytes: 4257, width: 1280, height: 720 })).toBe(true);
  });

  test("la piu' LEGGERA fra quelle vere resta evidenza", () => {
    // 0.0229 byte/px: e' il caso piu' vicino al confine, quindi quello che
    // rompe per primo se qualcuno alza il pavimento.
    expect(isBlankLikeImage({ bytes: Math.round(0.0229 * px(1440, 760)), width: 1440, height: 760 })).toBe(false);
  });

  test("tutte le altre densita' misurate passano", () => {
    for (const d of [0.0234, 0.0236, 0.024, 0.0333, 0.0562, 0.0623, 0.0655, 0.0676, 0.0683]) {
      const bytes = Math.round(d * px(1440, 760));
      expect(`${d}→${isBlankLikeImage({ bytes, width: 1440, height: 760 })}`).toBe(`${d}→false`);
    }
  });

  test("il pavimento sta in mezzo al vuoto misurato, non addosso a un caso", () => {
    expect(BLANK_DENSITY_FLOOR).toBeGreaterThan(0.0046);
    expect(BLANK_DENSITY_FLOOR).toBeLessThan(0.0229);
  });

  test("senza numeri non si emette un verdetto", () => {
    expect(isBlankLikeImage({ bytes: 0, width: 1280, height: 720 })).toBe(false);
    expect(isBlankLikeImage({ bytes: 4257, width: 0, height: 0 })).toBe(false);
  });
});
