import { expect } from "@playwright/test";
import { test } from "./fixtures/command-palette.fixture";
import { createTopic, cleanupAll, patchTopic } from "./helpers/api-fixtures";
import { goToApp } from "./helpers";
import { hermetic } from "./fixtures/hermetic";
hermetic(test);
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
test("probe on main: results scrolled by finger and a background rename", async ({ commandPalettePage, page, request }) => {
  const TS = Date.now(); const prefix = `E2E-PalHide-${TS}`; const ids: string[] = [];
  for (let i = 0; i < 30; i++) ids.push((await createTopic(request, `${prefix}-${String(i).padStart(2, "0")}`)).id);
  await goToApp(page);
  await commandPalettePage.search(prefix);
  await expect(commandPalettePage.overlay.getByRole("option", { name: new RegExp(`${prefix}-00`) })).toBeAttached();
  const selected = commandPalettePage.overlay.locator('[role="option"][aria-selected="true"]');
  const list = selected.locator("xpath=ancestor::*[contains(@class,'overflow-y-auto')][1]");
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    const w = window as unknown as { __hide: string[] };
    w.__hide = [];
    new MutationObserver((ms) => {
      for (const m of ms) {
        const t = m.target as HTMLElement;
        if (m.type === "attributes" && t.contains(el) && /display:\s*none/.test(t.getAttribute("style") ?? "")) w.__hide.push(`hidden ${t.tagName}.${(t.className || "").toString().slice(0, 40)} style=${t.getAttribute("style")}`);
        if (m.type === "childList") for (const n of Array.from(m.removedNodes)) if (n instanceof Element && n.contains(el)) w.__hide.push(`removed ${n.tagName}`);
      }
    }).observe(document.body, { attributes: true, attributeFilter: ["style", "class", "hidden"], subtree: true, childList: true });
    let n = 0; const loop = () => { if (el.offsetParent === null || getComputedStyle(el).display === "none") w.__hide.push(`frame ${n}: list not rendered`); if (n++ < 240) requestAnimationFrame(loop); }; requestAnimationFrame(loop);
  });
  await patchTopic(request, ids[5], { name: `${prefix}-05-renamed` });
  await expect(commandPalettePage.overlay.getByRole("option", { name: new RegExp(`${prefix}-05-renamed`) })).toBeAttached();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __n?: number }).__n ?? 0), { timeout: 1500 }).toBe(-1).catch(() => {});
  const out = await page.evaluate(() => (window as unknown as { __hide: string[] }).__hide);
  const after = await list.evaluate((el) => el.scrollTop);
  console.log("PROBE", JSON.stringify(out), "scrollTop", after);
  expect(after, `main: the list stays where the finger left it. hide=${JSON.stringify(out)}`).toBeGreaterThan(200);
  await cleanupAll(request, { topics: ids });
});
