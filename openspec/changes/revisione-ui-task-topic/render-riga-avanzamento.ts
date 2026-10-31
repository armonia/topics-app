/**
 * Renders riga-avanzamento-prima-dopo.html to a PNG next to it (2x scale).
 * Usage: bun run openspec/changes/revisione-ui-task-topic/render-riga-avanzamento.ts
 */
import { chromium } from "playwright";
import { join } from "node:path";

const dir = import.meta.dir;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 760, height: 400 }, deviceScaleFactor: 2 });
await page.goto(`file://${join(dir, "riga-avanzamento-prima-dopo.html")}`);
await page.locator("body").screenshot({ path: join(dir, "riga-avanzamento-prima-dopo.png") });
await browser.close();
