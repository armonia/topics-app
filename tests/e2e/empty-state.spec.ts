/**
 * empty-state.spec.ts — la primitiva condivisa `EmptyState` rende il "vuoto"
 * in modo LEGGIBILE nei due temi, in entrambe le varianti.
 *
 * Prima ogni pannello scriveva il suo vuoto a mano; il primo consumer della
 * primitiva è il Command Palette, che mostra le DUE varianti insieme quando la
 * ricerca non trova niente: la colonna sinistra (`section` — una riga in
 * corsivo) e la colonna destra (`panel` — centrata, generosa). Una query di
 * spazzatura le accende entrambe nello stesso frame: uno screenshot solo prova
 * tutte e due.
 *
 * Come board-theme.spec.ts, il tema si pilota con `emulateMedia({ colorScheme })`
 * e il contrasto lo misura un canvas 1×1 (niente regex sui colori oklch di
 * Tailwind v4). Gli screenshot restano allegati come prova durevole per l'umano.
 */
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures/command-palette.fixture";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";
import { mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

hermetic(test);

const MEDIA_DIR = join(homedir(), ".topics", "media");

/** Contrasto WCAG reale del testo di un elemento sullo sfondo composito. */
async function contrastOf(page: Page, selector: string): Promise<{ ratio: number; color: string; bg: string }> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`nessun elemento per il selettore ${sel}`);
    const probe = document.createElement("canvas");
    probe.width = probe.height = 1;
    const ctx = probe.getContext("2d", { willReadFrequently: true })!;
    const parse = (s: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = s;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const effectiveBg = (start: Element): [number, number, number] => {
      const stack: [number, number, number, number][] = [];
      let node: Element | null = start;
      while (node) {
        const [r, g, b, a] = parse(getComputedStyle(node).backgroundColor);
        if (a > 0) {
          stack.push([r, g, b, a]);
          if (a >= 1) break;
        }
        node = node.parentElement;
      }
      let [br, bg_, bb] = [255, 255, 255];
      for (let i = stack.length - 1; i >= 0; i--) {
        const [r, g, b, a] = stack[i];
        br = r * a + br * (1 - a);
        bg_ = g * a + bg_ * (1 - a);
        bb = b * a + bb * (1 - a);
      }
      return [br, bg_, bb];
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (c: number) => {
        const cs = c / 255;
        return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const fg = parse(getComputedStyle(el).color);
    const bg = effectiveBg(el);
    const l1 = lum([fg[0], fg[1], fg[2]]);
    const l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const toStr = (c: number[]) => `rgb(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])})`;
    return { ratio, color: toStr(fg), bg: toStr(bg) };
  }, selector);
}

test.describe("EmptyState", () => {
  test.beforeAll(() => {
    mkdirSync(MEDIA_DIR, { recursive: true });
  });

  for (const scheme of ["dark", "light"] as const) {
    test(`EMPTY-01 (${scheme}): le due varianti sono leggibili`, async ({ commandPalettePage, page }, testInfo) => {
      test.info().annotations.push({ type: "spec", description: "EMPTY-01" });
      await page.emulateMedia({ colorScheme: scheme });
      await goToApp(page);

      const isDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
      expect(isDark, `colorScheme=${scheme} → .dark=${scheme === "dark"}`).toBe(scheme === "dark");

      // Query di spazzatura: niente progetti/topic/file/messaggi la soddisfano,
      // quindi si accendono sia la sezione (sinistra) sia il pannello (destra).
      await commandPalettePage.search("zzzqqqxxx-nomatch-9713");

      const section = page.locator('[data-testid="empty-state"][data-variant="section"]');
      const panel = page.locator('[data-testid="empty-state"][data-variant="panel"]');
      await expect(section.first()).toBeVisible({ timeout: 5000 });
      await expect(panel.first()).toBeVisible({ timeout: 5000 });

      // Entrambe leggibili: il testo "muted" deve staccare dallo sfondo del
      // palette in tutti e due i temi (AA per testo secondario ≥ 3:1).
      for (const variant of ["section", "panel"] as const) {
        const { ratio, color, bg } = await contrastOf(page, `[data-testid="empty-state"][data-variant="${variant}"]`);
        testInfo.annotations.push({ type: "contrasto", description: `${scheme}/${variant}: ${ratio.toFixed(2)}:1 — ${color} su ${bg}` });
        expect(ratio, `contrasto ${variant} in ${scheme} (${color} su ${bg})`).toBeGreaterThanOrEqual(3);
      }

      const png = await commandPalettePage.overlay.screenshot();
      const file = join(MEDIA_DIR, `empty-state-${scheme}.png`);
      writeFileSync(file, png);
      await testInfo.attach(`empty-state-${scheme}.png`, { body: png, contentType: "image/png" });

      await commandPalettePage.close();
    });
  }
});
