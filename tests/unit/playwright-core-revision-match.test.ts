/**
 * @covers E2E-GATE-07
 */
import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

/**
 * Il `playwright-core` che usa il SERVER e quello che usa la SUITE devono
 * aspettarsi lo stesso Chromium.
 *
 * IL GUASTO. `server/browser-service.ts` importa `playwright-core` (dipendenza
 * diretta della radice); i test e2e usano `@playwright/test`, che si porta il
 * suo `playwright-core`. Sono due pacchetti distinti, e ognuno pretende una
 * REVISIONE precisa del browser: se divergono, `npx playwright install chromium`
 * — che usa la CLI di `@playwright/test` — scarica la revisione di QUELLA, e il
 * server cerca l'altra.
 *
 * Misurato il 2026-08-02 sul job `check`: core 1.58.2 voleva chromium **1208**,
 * la CLI installava **1217**, e sette test cadevano con
 *
 *     Chromium executable not found. Tried:
 *       …/ms-playwright/chromium-1208/chrome-linux64/chrome (not found on disk)
 *
 * In locale non si vede mai: la cache `~/…/ms-playwright` accumula ogni
 * revisione mai installata (qui ce n'erano cinque), quindi 1208 c'era da mesi e
 * tutto funzionava. È un rosso che esiste solo su una macchina pulita — cioè
 * solo su CI, dopo il push.
 *
 * Questo test è il guard-rail: fallisce quando le due versioni divergono, e lo
 * dice a `bun run test:unit`, prima del push invece che dopo.
 */

function browsersJsonFor(pkgDir: string): { chromium: string; version: string } | null {
  const browsers = resolve(pkgDir, "browsers.json");
  const pkg = resolve(pkgDir, "package.json");
  if (!existsSync(browsers) || !existsSync(pkg)) return null;
  const parsed = JSON.parse(readFileSync(browsers, "utf8")) as {
    browsers: Array<{ name: string; revision: string }>;
  };
  const chromium = parsed.browsers.find((b) => b.name === "chromium");
  if (!chromium) return null;
  return {
    chromium: String(chromium.revision),
    version: String(JSON.parse(readFileSync(pkg, "utf8")).version),
  };
}

/** Il core annidato sotto un pacchetto, se non è stato issato in cima. */
function resolveCore(...candidates: string[]): { chromium: string; version: string } | null {
  for (const c of candidates) {
    const found = browsersJsonFor(resolve(process.cwd(), c));
    if (found) return found;
  }
  return null;
}

describe("playwright-core: server e suite devono volere lo stesso Chromium", () => {
  test("le revisioni di chromium coincidono", () => {
    // Quello che il SERVER importa.
    const serverCore = resolveCore("node_modules/playwright-core");
    // Quello che la SUITE usa: annidato sotto playwright/@playwright/test se non
    // issato, altrimenti è lo stesso di sopra (ed è il caso sano).
    const suiteCore = resolveCore(
      "node_modules/playwright/node_modules/playwright-core",
      "node_modules/@playwright/test/node_modules/playwright-core",
      "node_modules/playwright-core",
    );

    // Senza node_modules non c'è niente da controllare: il test non deve
    // fallire per un checkout non installato.
    if (!serverCore || !suiteCore) return;

    expect(
      serverCore.chromium,
      `playwright-core@${serverCore.version} (server) vuole chromium ${serverCore.chromium}, ` +
        `ma la CLI di playwright@${suiteCore.version} installa ${suiteCore.chromium}. ` +
        `Allinea "playwright-core" in package.json alla versione di "@playwright/test".`,
    ).toBe(suiteCore.chromium);
  });
});
