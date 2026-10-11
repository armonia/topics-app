/**
 * PROVIDERS AND KEYS INSIDE THE MODEL SELECTOR, ON THE AUDIT FLEET.
 *
 * openspec/changes/archive/2026-10-04-model-selector/revision-2026-10-04.md §5, AC-06, AC-07,
 * AC-18..AC-29, AC-34, AC-37, AC-40: the providers level opens in the same
 * panel as the models (same x, y, width), ‹ and Escape go back with the search,
 * the open sections and the scroll as they were, a second Escape closes and
 * the focus is on the chip; one card per provider, one state, at most one
 * action; the detail with a fixed heading and the default model chosen in it.
 * The snapshot is handed in through the route and the WS push; the settings
 * the detail writes are caught by a route, so the test server keeps its own.
 *
 * @covers SETHOME-01 USERMENU-10 AICTRL-01 MSEL-01
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { join, resolve } from "node:path";
import type { AxeResults } from "axe-core";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import type { ProvidersSnapshot } from "../../shared/types";
import { KEYS, NO_KEYS, mockSnapshot, snapshotOf } from "./fixtures/model-panels-fleet";

hermetic(test);
// On WebKit a page the service worker controls (from its second load on) sends
// its requests past `page.route`: the snapshot and the settings this file
// hands in would come from the test server instead (seen 04/10, the key form's
// POST reached the server once in four runs). Same fix as chat-tail-first.
test.use({ serviceWorkers: "block" });
test.use({ video: "on" });

/** The order of the cards on the fleet «with keys»: the table, then the endpoints. */
const KEYS_ORDER = ["claude-code", "topics", "claude", "codex", "openai", "gemini", "jcode", "goose", "direct-ollama", "direct-openrouter"];
const wholeWord = (word: string) => new RegExp(`(^|[^\\p{L}])${word}([^\\p{L}]|$)`, "u");

let topicId = "";
let topicName = "";
test.beforeAll(async ({ request }) => {
  topicName = `Providers level ${Date.now()}`;
  topicId = (await createTopic(request, topicName)).id;
});
test.afterAll(async ({ request }) => {
  if (topicId) await deleteTopic(request, topicId);
});

/** The settings the detail reads and writes, kept in the page's own memory. */
async function mockSettings(page: Page) {
  const writes: Array<Record<string, unknown>> = [];
  let settings: Record<string, unknown> | null = null;
  await page.route("**/api/app-settings", async (route) => {
    if (!settings) settings = (await (await route.fetch()).json() as { settings: Record<string, unknown> }).settings;
    if (route.request().method() === "PUT") {
      const patch = route.request().postDataJSON() as Record<string, unknown>;
      writes.push(patch);
      settings = { ...settings, ...patch };
    }
    await route.fulfill({ json: { settings } });
  });
  // No programs and no endpoints of this machine: every card is the snapshot's.
  await page.route("**/api/providers/cli", (route) => route.fulfill({ json: { agents: [] } }));
  await page.route("**/api/providers/endpoints", (route) => route.fulfill({ json: { endpoints: [] } }));
  return writes;
}

async function openChat(page: Page, request: Parameters<typeof resetPaneStore>[0], snapshot: ProvidersSnapshot) {
  await request.patch(`/api/topics/${topicId}`, { data: { provider: "claude-code", model: null, topicsRouting: true } });
  await resetPaneStore(request, [topicId]);
  await mockSnapshot(page, snapshot);
  const writes = await mockSettings(page);
  await goToApp(page);
  await page.keyboard.press("Escape");
  await openTopic(page, new RegExp(topicName));
  const picker = page.getByTestId("provider-model-picker");
  await picker.waitFor({ state: "visible", timeout: 10_000 });
  return { picker, writes };
}

const popover = (page: Page) => page.getByTestId("provider-model-popover");
const models = (page: Page) => page.getByTestId("model-selector-panel");
const level = (page: Page) => page.getByTestId("providers-level");
const card = (page: Page, name: string) => level(page).getByTestId(`provider-card-${name}`);
const rect = (el: Locator) => el.evaluate((node) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });

async function openProvidersLevel(page: Page, picker: Locator) {
  await picker.click();
  await expect(models(page)).toBeVisible();
  await models(page).getByTestId("ai-selector-providers").click();
  await expect(level(page)).toBeVisible();
}

async function axeViolations(page: Page, include: string) {
  await page.addScriptTag({ path: resolve(__dirname, "../../node_modules/axe-core/axe.min.js") });
  return page.evaluate(async (selector) => {
    const axe = (window as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<AxeResults> } }).axe;
    const result = await axe.run({ include: [[selector]] }, {
      runOnly: { type: "rule", values: ["aria-required-children", "nested-interactive", "scrollable-region-focusable", "color-contrast", "button-name"] },
    });
    return result.violations.map(({ id, nodes }) => ({ id, nodes: nodes.slice(0, 4).map(({ target, failureSummary }) => ({ target, failureSummary })) }));
  }, include);
}

/** The evidence for the maintainer, when `MSEL_SHOTS_DIR` is set (openspec/changes/archive/2026-10-04-model-selector/screenshots). */
async function shot(page: Page, name: string) {
  const dir = process.env.MSEL_SHOTS_DIR;
  if (dir) await page.screenshot({ path: join(dir, `revision-impl-${name}.png`) });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
  test.describe(`desktop ${viewport.width} × ${viewport.height}, with keys`, () => {
    test.use({ viewport });

    test("the level takes the panel's place, goes back intact, and a second Escape closes (AC-20, AC-21, AC-22)", async ({ page, request }) => {
      const { picker } = await openChat(page, request, KEYS);
      await picker.click();
      await expect(models(page)).toBeVisible();
      // The models as somebody left them: a search typed, a section opened, the list scrolled.
      await models(page).getByTestId("model-section-anthropic").getByTestId("model-section-older").click();
      await models(page).getByTestId("model-selector-search").fill("o");
      const scroller = models(page).getByTestId("model-selector-sections");
      await scroller.evaluate((el) => { el.scrollTop = 40; });
      const scrolled = await scroller.evaluate((el) => el.scrollTop);
      expect(scrolled).toBeGreaterThan(0);
      const before = await rect(popover(page));
      const footerTail = await models(page).getByTestId("ai-selector-providers-tail").innerText();

      await models(page).getByTestId("ai-selector-providers").click();
      await expect(level(page)).toBeVisible();
      await expect(page.getByTestId("home-panel-providers")).toHaveCount(0);
      const after = await rect(popover(page));
      expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(1);
      expect(after.height).toBeGreaterThanOrEqual(before.height - 1);
      // AC-22: the heading's count is the foot's, and the ready cards.
      await expect(page.getByTestId("providers-level-count")).toHaveText("9 pronti · 1 errore");
      expect(footerTail).toBe("9 pronti · 1 errore");
      expect(await level(page).locator(':scope > li[data-status="ready"]').count()).toBe(9);
      // AC-21 (amended 06/10): in the narrow panel the list scrolls like the
      // phone's; every card is reachable and none is cut: top card whole at
      // the top, last card whole at the bottom.
      const scroll = page.getByTestId("providers-level-scroll");
      const cards = level(page).locator(":scope > li");
      await expect(cards).toHaveCount(10);
      await scroll.evaluate((el) => { el.scrollTop = 0; });
      const [first, top] = [await rect(cards.first()), await rect(scroll)];
      expect(first.y).toBeGreaterThanOrEqual(top.y - 0.5);
      expect(first.y + first.height).toBeLessThanOrEqual(top.y + top.height + 0.5);
      await scroll.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      const [last, bottom] = [await rect(cards.last()), await rect(scroll)];
      expect(last.y).toBeGreaterThanOrEqual(bottom.y - 0.5);
      expect(last.y + last.height).toBeLessThanOrEqual(bottom.y + bottom.height + 0.5);
      await scroll.evaluate((el) => { el.scrollTop = 0; });
      await page.screenshot({ path: test.info().outputPath(`providers-level-${viewport.width}.png`) });

      // ‹ goes back to the models as they were.
      await page.getByTestId("level-back").click();
      await expect(models(page)).toBeVisible();
      await expect(models(page).getByTestId("model-selector-search")).toHaveValue("o");
      expect(await scroller.evaluate((el) => el.scrollTop)).toBe(scrolled);
      await expect(models(page).getByTestId("ai-selector-providers")).toBeFocused();

      // Escape too, and a second Escape closes with the focus on the chip.
      await models(page).getByTestId("ai-selector-providers").click();
      await expect(level(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(models(page)).toBeVisible();
      await expect(models(page).getByTestId("model-selector-search")).toHaveValue("o");
      expect(await scroller.evaluate((el) => el.scrollTop)).toBe(scrolled);
      // The section opened before the search is still open once it is cleared.
      await models(page).getByTestId("model-selector-search").fill("");
      await expect(models(page).getByTestId("model-section-anthropic").getByTestId("model-section-older")).toHaveAttribute("aria-expanded", "true");
      await models(page).getByTestId("ai-selector-providers").focus();
      await page.keyboard.press("Escape");
      await expect(popover(page)).toHaveCount(0);
      await expect(picker).toBeFocused();
    });

    test("every engine the selector names has one card, in view, with the company of its column (AC-07)", async ({ page, request }) => {
      const { picker } = await openChat(page, request, KEYS);
      await picker.click();
      // Every engine name the selector writes: headings, «via X», the ⌄ choices.
      const named = await models(page).evaluate((panel) => {
        const out: Array<{ engine: string; maker: string }> = [];
        for (const group of panel.querySelectorAll<HTMLElement>("[data-maker]")) {
          const maker = group.querySelector("[id^='model-group-']")?.textContent ?? "";
          const who = group.querySelector("[data-testid='model-group-who'], [data-testid='model-group-engine']")?.textContent ?? "";
          if (who) out.push({ engine: who.replace(/^via /, ""), maker });
          for (const via of group.querySelectorAll("[data-testid='model-row-via']")) out.push({ engine: (via.textContent ?? "").replace(/^via /, ""), maker });
        }
        return out;
      });
      for (const group of ["anthropic", "openai", "meta"]) {
        await models(page).getByTestId(`model-section-${group}`).getByTestId("model-group-engine").click();
        const choices = await models(page).getByTestId("model-group-engines").locator("[data-engine-choice]").evaluateAll((els) => els.map((el) => el.textContent ?? ""));
        const maker = await models(page).getByTestId(`model-section-${group}`).locator("[id^='model-group-']").innerText();
        for (const choice of choices) named.push({ engine: choice.replace(/ · in Topics$/, ""), maker });
        await page.keyboard.press("Escape");
      }
      await models(page).getByTestId("ai-selector-providers").click();
      await expect(level(page)).toBeVisible();
      const scroll = await rect(page.getByTestId("providers-level-scroll"));
      expect(named.length).toBeGreaterThan(8);
      for (const { engine, maker } of named) {
        // «Topics» is who runs it through the band: the Topics card.
        const cards = level(page).locator(":scope > li").filter({ has: page.locator(`[data-testid="provider-card-open"] >> text="${engine}"`) });
        await expect(cards, `${engine}`).toHaveCount(1);
        // AC-07 (amended 06/10): the list scrolls, so each card is brought
        // into view before the check; a card in view is whole, not cut.
        await cards.scrollIntoViewIfNeeded();
        const box = await rect(cards);
        expect(box.y >= scroll.y - 0.5 && box.y + box.height <= scroll.y + scroll.height + 0.5, `${engine} in view`).toBe(true);
        const makers = cards.getByTestId("provider-card-makers");
        await expect(makers, `${engine} serves ${maker}`).toContainText(maker, { ignoreCase: true });
        expect((await cards.getByTestId("provider-card-open").getAttribute("aria-label"))?.toLowerCase()).toContain(maker.toLowerCase());
      }
    });

    test("axe finds no violation of the five rules on the list, light and dark (AC-34)", async ({ page, request }) => {
      const { picker } = await openChat(page, request, KEYS);
      await openProvidersLevel(page, picker);
      await shot(page, `providers-${viewport.width}-light`);
      expect(await axeViolations(page, '[data-testid="providers-level"]'), "light").toEqual([]);
      await page.emulateMedia({ colorScheme: "dark" });
      await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
      await shot(page, `providers-${viewport.width}-dark`);
      expect(await axeViolations(page, '[data-testid="providers-level"]'), "dark").toEqual([]);
    });
  });
}

test.describe("desktop 1440 × 900, the list and the detail", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the whole gesture: open, «Provider e chiavi», ‹ back with the models as they were, pick a model (AC-20)", async ({ page, request }) => {
    const { picker } = await openChat(page, request, KEYS);
    await picker.click();
    await expect(models(page)).toBeVisible();
    const search = models(page).getByTestId("model-selector-search");
    const openAiGroup = models(page).getByTestId("model-section-openai");
    const older = openAiGroup.getByTestId("model-section-older");
    await older.click();
    await expect(older).toHaveAttribute("aria-expanded", "true");
    const placed = await rect(popover(page));
    // A search that leaves a few rows does not move or shrink the panel.
    await search.fill("gpt-5");
    const same = (box: { x: number; y: number; width: number; height: number }) => {
      for (const key of ["x", "y", "width", "height"] as const) expect(Math.abs(box[key] - placed[key]), key).toBeLessThanOrEqual(1);
    };
    // Measured once the rows are filtered and `Menu` has had two frames to place it again.
    await expect(models(page).getByTestId("model-section-anthropic")).toHaveCount(0);
    const settled = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    await settled();
    same(await rect(popover(page)));
    await models(page).getByTestId("ai-selector-providers").click();
    await expect(level(page)).toBeVisible();
    await expect(card(page, "codex")).toBeVisible();
    await page.getByTestId("level-back").click();
    await expect(models(page)).toBeVisible();
    await expect(models(page).getByTestId("ai-selector-providers")).toBeFocused();
    await settled();
    same(await rect(popover(page)));
    await expect(search).toHaveValue("gpt-5");
    await search.fill("");
    await expect(older).toHaveAttribute("aria-expanded", "true");
    await openAiGroup.locator('[data-testid="model-row"][data-model="gpt-5.5"]').first().click();
    await expect(popover(page)).toHaveCount(0);
    await expect(picker).toHaveAttribute("data-model", "gpt-5.5");
    await expect(page.getByTestId("provider-model-picker-label")).toHaveText(/^GPT-5\.5 · via /);
    const video = page.video();
    const dir = process.env.MSEL_SHOTS_DIR;
    if (video && dir) {
      await page.close();
      await video.saveAs(join(dir, "revision-impl-flow.webm"));
    }
  });

  test("one list, the snapshot's providers once in the fixed order, no group titles (AC-06, AC-28, AC-29)", async ({ page, request }) => {
    const { picker } = await openChat(page, request, KEYS);
    await openProvidersLevel(page, picker);
    await expect(level(page).locator('[role="group"], [role="heading"], h1, h2, h3, h4, h5, h6')).toHaveCount(0);
    const names = await level(page).locator(":scope > li").evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")!.replace("provider-card-", "")));
    expect(names).toEqual(KEYS_ORDER);
    await expect(card(page, "topics").getByTestId("provider-card-open")).toContainText("Topics");
    const text = (await page.getByTestId("model-selector-level").innerText()).replace(/\s+/g, " ");
    for (const word of ["Altri", "Altro", "Other", "Others", "Varie", "Misc", "Endpoints", "Agenti", "Agents", "API", "Locali", "Local"]) {
      // Card names say «Claude API», «OpenAI API»: a title would be the word alone.
      if (word === "API") continue;
      expect(text, word).not.toMatch(wholeWord(word));
    }
    for (const word of ["Updated", "ago", "Copy", "Model", "Automatic", "Default"]) expect(text, word).not.toMatch(wholeWord(word));
    // AC-29: the same word and colour for the same state, in the selector and on the card.
    await expect(card(page, "goose").getByTestId("provider-card-status")).toHaveText("Errore");
    const goose = await card(page, "goose").locator('[role="img"]').evaluate((el) => ({ word: el.getAttribute("aria-label"), colour: getComputedStyle(el).backgroundColor }));
    const ready = await card(page, "codex").locator('[role="img"]').evaluate((el) => ({ word: el.getAttribute("aria-label"), colour: getComputedStyle(el).backgroundColor }));
    await page.getByTestId("level-back").click();
    const selectorReady = await models(page).getByTestId("model-section-openai").locator('[role="img"]').first().evaluate((el) => ({ word: el.getAttribute("aria-label"), colour: getComputedStyle(el).backgroundColor }));
    expect(ready).toEqual(selectorReady);
    expect(goose.word).toBe("Errore");
    // AC-06, the order that does not move with 134 jcode models, is measured
    // on the cards themselves in `providersModel.test.ts`.
  });

  test("Claude Code's detail: fixed heading, plan, the default model chosen in line (AC-23, AC-24, AC-25)", async ({ page, request }) => {
    const { picker, writes } = await openChat(page, request, KEYS);
    await openProvidersLevel(page, picker);
    const panelHeight = (await rect(popover(page))).height;
    await card(page, "claude-code").getByTestId("provider-card-open").click();
    const detail = page.getByTestId("provider-detail-claude-code");
    await expect(detail).toBeVisible();
    expect(Math.abs((await rect(popover(page))).height - panelHeight)).toBeLessThanOrEqual(1);
    await expect(detail.getByTestId("provider-detail-status")).toContainText("Pronto");
    await expect(detail.getByTestId("provider-detail-test")).toBeVisible();
    await expect(detail.getByTestId("provider-detail-plan")).toBeVisible();
    // AC-25: radios in line, no popover opened.
    const popovers = await page.locator("[data-popover]").count();
    const list = detail.getByTestId("provider-default-model-claude-code");
    await expect(list.getByTestId("provider-default-model-auto")).toHaveAttribute("aria-checked", "true");
    await list.locator('[data-model="claude-sonnet-5-5"]').click();
    await expect.poll(() => writes.some((w) => w.claudeModel === "claude-sonnet-5-5")).toBe(true);
    await expect(list.locator('[data-model="claude-sonnet-5-5"]')).toHaveAttribute("aria-checked", "true");
    expect(await page.locator("[data-popover]").count()).toBe(popovers);
    // AC-24: the heading stays where it is with the body scrolled to the end.
    const header = detail.getByTestId("provider-detail-header");
    const top = await rect(header);
    await detail.getByTestId("provider-detail-body").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    expect(await rect(header)).toEqual(top);
    await page.screenshot({ path: test.info().outputPath("detail-claude-code.png") });
    // Escape: the detail goes back to the list, on the card that was opened.
    await page.keyboard.press("Escape");
    await expect(level(page)).toBeVisible();
    await expect(card(page, "claude-code").getByTestId("provider-card-open")).toBeFocused();
  });

  test("jcode and Topics have their cards; Topics has no default, and holds the settings for every chat (AC-23, AC-27)", async ({ page, request }) => {
    const { picker } = await openChat(page, request, KEYS);
    await openProvidersLevel(page, picker);
    await expect(card(page, "topics").getByTestId("provider-card-action")).toHaveCount(0);
    await expect(card(page, "topics")).not.toContainText("Predefinito");
    await card(page, "jcode").getByTestId("provider-card-open").click();
    await expect(page.getByTestId("provider-detail-jcode").getByTestId("provider-detail-test")).toBeVisible();
    await page.getByTestId("level-back").click();
    await card(page, "topics").getByTestId("provider-card-open").click();
    const topics = page.getByTestId("provider-detail-topics");
    await expect(topics.getByTestId("provider-detail-test")).toBeVisible();
    await expect(topics).not.toContainText("Predefinito");
    await expect(topics.getByTestId("provider-default-set")).toHaveCount(0);
    const everyChat = topics.getByTestId("provider-detail-every-chat");
    await expect(everyChat).toContainText("Per tutte le chat");
    await expect(everyChat.getByRole("combobox", { name: "Motore degli agenti", exact: true })).toBeVisible();
    await expect(everyChat).toContainText("Checkpoint a ogni turno");
    // A list opened inside the detail closes first; then Escape goes back.
    await everyChat.getByRole("combobox", { name: "Motore degli agenti", exact: true }).click();
    const listbox = page.getByRole("listbox").last();
    await expect(listbox).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(listbox).toHaveCount(0);
    await expect(topics).toBeVisible();
    const axe = await axeViolations(page, '[data-testid="provider-detail-topics"]');
    expect(axe).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(level(page)).toBeVisible();
    expect(await axeViolations(page, '[data-testid="providers-level"]')).toEqual([]);
  });

  test("axe finds nothing on the list and on a detail in the dark theme (AC-34)", async ({ page, request }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    const { picker } = await openChat(page, request, KEYS);
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
    await openProvidersLevel(page, picker);
    expect(await axeViolations(page, '[data-testid="providers-level"]')).toEqual([]);
    await card(page, "claude-code").getByTestId("provider-card-open").click();
    await expect(page.getByTestId("provider-detail-claude-code")).toBeVisible();
    expect(await axeViolations(page, '[data-testid="provider-detail-claude-code"]')).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("detail-dark.png") });
  });

  test("the palette and the plan-limit doors open this chip's selector on the right level (AC-26)", async ({ page, request }) => {
    const { picker } = await openChat(page, request, KEYS);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("topics:open-home", { detail: { home: "providers" } })));
    await expect(popover(page)).toBeVisible();
    await expect(level(page)).toBeVisible();
    await expect(page.getByTestId("home-panel-providers")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(popover(page)).toHaveCount(0);
    await expect(picker).toBeFocused();
    // The plan-limit notice asks for Claude Code's detail.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("topics:open-home", { detail: { home: "providers", account: "claude-code" } })));
    await expect(page.getByTestId("provider-detail-claude-code")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(level(page)).toBeVisible();
  });
});

test.describe("without keys, 1440 × 900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("one press for «Accedi», › for the navigations, the action first in the detail (AC-18, AC-19, AC-24)", async ({ page, request }) => {
    await page.addInitScript(() => {
      window.addEventListener("topics:open-terminal-with-command", (event) => {
        (window as unknown as { __terminal: unknown[] }).__terminal = [...((window as unknown as { __terminal?: unknown[] }).__terminal ?? []), (event as CustomEvent).detail];
        event.stopImmediatePropagation();
      });
      localStorage.setItem("topics.modelSelector.hiddenConnect", JSON.stringify(["codex"]));
    });
    const { picker } = await openChat(page, request, NO_KEYS);
    // AC-19: the connect box of OpenAI is hidden, the card is still there with its action.
    await picker.click();
    await expect(models(page).getByTestId("model-section-openai")).toHaveCount(0);
    await models(page).getByTestId("ai-selector-providers").click();
    const codex = card(page, "codex");
    await expect(codex.getByTestId("provider-card-status")).toHaveText("Da collegare");
    await expect(codex.getByTestId("provider-card-action")).toHaveText("Accedi");
    await expect(card(page, "gemini").getByTestId("provider-card-action")).toHaveText("Configura ›");
    await expect(card(page, "direct-lmstudio").getByTestId("provider-card-action")).toHaveText("Riprova");
    // The detail of a provider to connect: the action is the first line of the body.
    await codex.getByTestId("provider-card-open").click();
    const detail = page.getByTestId("provider-detail-codex");
    const body = await rect(detail.getByTestId("provider-detail-body"));
    const action = await rect(detail.getByTestId("provider-detail-sign-in"));
    expect(action.y - body.y).toBeLessThanOrEqual(120);
    await expect(detail.getByTestId("provider-detail-copy-command")).toHaveText("Copia comando");
    await page.keyboard.press("Escape");
    // «Accedi» on the card acts at the first press and closes the panel.
    await codex.getByTestId("provider-card-action").click();
    await expect(popover(page)).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __terminal: unknown[] }).__terminal)).toEqual([{ command: "codex login" }]);
    // «Configura ›» from the connect box opens Gemini CLI's detail.
    await picker.click();
    await models(page).getByTestId("model-section-google").getByTestId("model-connect-action").click();
    await expect(page.getByTestId("provider-detail-gemini")).toBeVisible();
    await expect(page.getByTestId("provider-detail-gemini").getByTestId("provider-detail-action")).toBeVisible();
  });

  test("«Aggiungi chiave ›» opens the key field focused, and the key reaches the server (AC-18)", async ({ page, request }) => {
    const sent: string[] = [];
    await page.route("**/api/providers/openai/configure", async (route) => {
      sent.push((route.request().postDataJSON() as { apiKey: string }).apiKey);
      await route.fulfill({ status: 400, json: { error: "Connection rejected. Check the API key.", code: "api_key_rejected" } });
    });
    const withKeyMissing = snapshotOf([...NO_KEYS.providers, {
      ...KEYS.providers.find((p) => p.name === "openai")!, status: "unavailable", models: [],
      requirements: [{ key: "OPENAI_API_KEY", label: "Chiave OpenAI", present: false }],
    }]);
    const { picker } = await openChat(page, request, withKeyMissing);
    await openProvidersLevel(page, picker);
    const action = card(page, "openai").getByTestId("provider-card-action");
    await expect(action).toHaveText("Aggiungi chiave ›");
    await action.click();
    const field = page.getByTestId("provider-detail-openai").getByTestId("api-key-form-openai").locator("input");
    await expect(field).toBeFocused();
    await page.keyboard.type("sk-test-1");
    await page.keyboard.press("Enter");
    await expect.poll(() => sent).toEqual(["sk-test-1"]);
    await expect(page.getByTestId("api-key-form-openai").getByRole("alert")).toBeVisible();
  });
});

test.describe("no chip on screen", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the palette opens a centred sheet as wide as the selector, without ‹ (AC-26)", async ({ page, request }) => {
    // No chat open, so no model chip anywhere.
    await resetPaneStore(request, []);
    await mockSnapshot(page, KEYS);
    await mockSettings(page);
    await goToApp(page);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("topics:open-home", { detail: { home: "providers" } })));
    const sheet = page.getByTestId("home-panel-providers");
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute("data-popover-owner", "centred");
    const box = await rect(sheet);
    expect(Math.round(box.width)).toBe(704);
    await expect(sheet.getByTestId("providers-level")).toBeVisible();
    await expect(sheet.getByTestId("level-back")).toHaveCount(0);
    await sheet.getByTestId("provider-card-codex").getByTestId("provider-card-open").click();
    await expect(sheet.getByTestId("provider-detail-codex")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet.getByTestId("providers-level")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  });
});

test.describe("phone 390 × 844", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("targets of 44, one column, the status wraps, the body scrolls (AC-37, AC-40)", async ({ page, request }) => {
    const { picker } = await openChat(page, request, KEYS);
    await openProvidersLevel(page, picker);
    const small = (root: Locator) => root.locator("button, input, summary").evaluateAll((els) => els
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => { const r = el.getBoundingClientRect(); return { id: el.getAttribute("data-testid") ?? el.textContent?.slice(0, 20), w: Math.round(r.width), h: Math.round(r.height) }; })
      .filter((t) => t.w < 44 || t.h < 44));
    expect(await small(page.getByTestId("model-selector-level"))).toEqual([]);
    const columns = await level(page).evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
    expect(columns).toBe(1);
    await card(page, "claude-code").getByTestId("provider-card-open").click();
    const detail = page.getByTestId("provider-detail-claude-code");
    await expect(detail).toBeVisible();
    expect(await small(detail)).toEqual([]);
    const body = detail.getByTestId("provider-detail-body");
    expect(await body.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    const status = detail.getByTestId("provider-detail-status");
    expect(await status.evaluate((el) => getComputedStyle(el.querySelector("span:last-child")!).textOverflow)).not.toBe("ellipsis");
    // One column: the label above its value.
    const row = detail.getByTestId("provider-detail-default-model");
    const [label, value] = await row.evaluate((el) => [...el.children].map((child) => child.getBoundingClientRect().top));
    expect(value!).toBeGreaterThan(label!);
    await page.screenshot({ path: test.info().outputPath("detail-phone.png") });
  });

  test("axe finds no violation of the five rules on the phone list, light and dark (AC-34)", async ({ page, request }) => {
    const { picker } = await openChat(page, request, KEYS);
    await openProvidersLevel(page, picker);
    await shot(page, "providers-phone-light");
    expect(await axeViolations(page, '[data-testid="providers-level"]'), "light").toEqual([]);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
    await shot(page, "providers-phone-dark");
    expect(await axeViolations(page, '[data-testid="providers-level"]'), "dark").toEqual([]);
  });
});
