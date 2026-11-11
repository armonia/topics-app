// scripts/ui-variant-shield.mjs - regression for card 2b04c1f2: a sidebar row menu left open by one crawler probe kept its
// z-9999 click-away layer over the dialog «Nuova variante» of the next probe, because the demo reset remounted the pane but
// not the sidebar. Opens the menu, resets, opens the dialog and clicks its text area. Exit 0 = the click lands.
// allow-italian: quotes the words on screen
import { webkit } from "playwright";
import { serveDist } from "./ui-app/serve.mjs";

const { base, close } = await serveDist("ui-variant-shield", "sarim");
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`${base}?fresh=1&speed=0.02#/da-fare`);
await page.waitForFunction(() => window.__demo);
const place = (await page.evaluate(() => window.__demo.places())).find((x) => x.id === "sarim-contract");
let sample;
for (const s of place.samples) {
  await page.evaluate((x) => window.__demo.reset(x), s);
  await page.waitForTimeout(300);
  if (await page.locator("button:not([aria-disabled=true])", { hasText: /^Nuova variante$/ }).count()) { sample = s; break; }
}
if (!sample) { console.log("ui-variant-shield: no contract with «Nuova variante» enabled"); process.exit(2); }
const reset = async () => {
  await page.evaluate((s) => window.__demo.reset(s), sample);
  await page.waitForFunction((s) => document.querySelector("[data-screen]")?.getAttribute("data-route") === `#${s}`, sample);
  await page.waitForTimeout(200);
};
await reset();
await page.locator("[aria-haspopup=menu]").first().click({ force: true });
await page.waitForSelector("[role=menu]");
await reset();
await page.locator("button:not([aria-disabled=true])", { hasText: /^Nuova variante$/ }).first().click({ timeout: 3000, force: true });
let ok = true;
try {
  await page.locator("[role=dialog] textarea").first().click({ timeout: 2000 });
} catch (e) {
  ok = false;
  console.log(String(e.message).split("\n").filter((l) => /intercepts|Timeout/.test(l)).slice(0, 3).join(" | "));
}
await browser.close();
close();
console.log(ok ? "ui-variant-shield: ok" : "ui-variant-shield: FAIL, the dialog is covered");
process.exit(ok ? 0 : 1);
