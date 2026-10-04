/**
 * THE MODEL SELECTOR OF THE REVISION OF 2026-10-04, ON THE AUDIT FLEET.
 *
 * openspec/changes/archive/2026-10-04-model-selector/revision-2026-10-04.md §11: the fixture of
 * the audit «with keys» (Claude Code, Claude API, Codex, OpenAI API, Gemini
 * CLI, jcode, an Ollama and an OpenRouter endpoint, goose in error) and
 * «without keys», plus the 134 ids jcode really lists. The snapshot is handed
 * in through the route and the WS push; no provider is called.
 *
 * @covers MSEL-02 MSEL-04 MSEL-05 MSEL-08 AICTRL-02
 */
import { expect, test, type Page } from "@playwright/test";
import { join, resolve } from "node:path";
import type { AxeResults } from "axe-core";
import { goToApp, openTopic } from "./helpers";
import { longPress } from "./helpers/long-press";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import type { ProvidersSnapshot } from "../../shared/types";
import { JCODE_IDS, KEYS, NO_KEYS, claudeCode, engine, mockSnapshot, row, snapshotOf } from "./fixtures/model-panels-fleet";

hermetic(test);
// On WebKit a page the service worker controls (from its second load on) sends
// its requests past `page.route`: the snapshot and the settings this file
// hands in would come from the test server instead (seen 04/10, the key form's
// POST reached the server once in four runs). Same fix as chat-tail-first.
test.use({ serviceWorkers: "block" });

let topicId = "";
let topicName = "";
test.beforeAll(async ({ request }) => {
  topicName = `Model selector revision ${Date.now()}`;
  topicId = (await createTopic(request, topicName)).id;
});
test.afterAll(async ({ request }) => {
  if (topicId) await deleteTopic(request, topicId);
});

async function openSelector(page: Page, request: Parameters<typeof resetPaneStore>[0], snapshot: ProvidersSnapshot, model: string | null = null, provider?: string | null) {
  const engineOf = model ? (model.startsWith("gemini") ? "gemini" : "claude-code") : "claude-code";
  await request.patch(`/api/topics/${topicId}`, { data: { provider: provider === undefined ? engineOf : provider, model, topicsRouting: true } });
  await resetPaneStore(request, [topicId]);
  await mockSnapshot(page, snapshot);
  await goToApp(page);
  await page.keyboard.press("Escape");
  await openTopic(page, new RegExp(topicName));
  const picker = page.getByTestId("provider-model-picker");
  await picker.waitFor({ state: "visible", timeout: 10_000 });
  await picker.click();
  await expect(panel(page)).toBeVisible();
  return picker;
}

const panel = (page: Page) => page.getByTestId("model-selector-panel");
const section = (page: Page, maker: string) => panel(page).getByTestId(`model-section-${maker}`);
const box = async (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
});

/** How many of a column's stops (rows, «Precedenti») are inside its visible box. */
async function visibleStops(page: Page, column: number): Promise<{ visible: number; total: number }> {
  return panel(page).locator(`[data-model-column="${column}"]`).evaluate((col) => {
    const c = col.getBoundingClientRect();
    const stops = [...col.querySelectorAll<HTMLElement>('[data-testid="model-row"], [data-testid="model-section-older"]')];
    const visible = stops.filter((el) => { const r = el.getBoundingClientRect(); return r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5; });
    return { visible: visible.length, total: stops.length };
  });
}

async function axeViolations(page: Page) {
  await page.addScriptTag({ path: resolve(__dirname, "../../node_modules/axe-core/axe.min.js") });
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<AxeResults> } }).axe;
    const result = await axe.run({ include: [['[data-testid="model-selector-panel"]']] }, {
      runOnly: { type: "rule", values: ["aria-required-children", "nested-interactive", "scrollable-region-focusable", "color-contrast", "button-name"] },
    });
    return result.violations.map(({ id, nodes }) => ({ id, nodes: nodes.slice(0, 4).map(({ target, failureSummary }) => ({ target, failureSummary })) }));
  });
}

/** Every WCAG 2.1 A/AA rule, keeping what axe calls serious or critical. */
async function seriousViolations(page: Page, include: string) {
  await page.addScriptTag({ path: resolve(__dirname, "../../node_modules/axe-core/axe.min.js") });
  return page.evaluate(async (selector) => {
    const axe = (window as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<AxeResults> } }).axe;
    const result = await axe.run({ include: [[selector]] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
    return result.violations.filter((v) => v.impact === "serious" || v.impact === "critical")
      .map(({ id, nodes }) => ({ id, nodes: nodes.slice(0, 4).map(({ target, failureSummary }) => ({ target, failureSummary })) }));
  }, include);
}

/** The evidence for the maintainer, when `MSEL_SHOTS_DIR` is set (openspec/changes/archive/2026-10-04-model-selector/screenshots). */
async function shot(page: Page, name: string) {
  const dir = process.env.MSEL_SHOTS_DIR;
  if (dir) await page.screenshot({ path: join(dir, `revision-impl-${name}.png`) });
}

test.describe("desktop 1440 × 900, with keys", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("columns by company, headings, «via X», the engine in place, room and accessibility", async ({ page, request }) => {
    await openSelector(page, request, KEYS);
    // AC-01, AC-04: no catch-all; Anthropic, OpenAI, Google, then the others stacked.
    await expect(panel(page).getByTestId("model-section-other")).toHaveCount(0);
    const columns = await panel(page).getByTestId("model-column").evaluateAll((cols) => cols.map((col) =>
      [...col.querySelectorAll('[role="group"]')].map((group) => group.getAttribute("data-maker"))));
    expect(columns).toEqual([["anthropic"], ["openai"], ["google"], ["meta", "deepseek", "mistral", "qwen", "xai"]]);
    await expect(section(page, "google").locator('[data-model="gemini-3-pro"]')).toHaveCount(1);
    await expect(section(page, "openai").locator('[data-testid="model-row"]').filter({ hasText: "GPT-OSS 20B" })).toHaveCount(1);

    // AC-14: one heading height for every group, two lines; ⌄ only from two engines.
    const heights = await panel(page).getByTestId("model-section-heading").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
    await expect(section(page, "meta").getByTestId("model-group-engine")).toContainText("via Ollama (Mac mini)");
    await expect(section(page, "deepseek").getByTestId("model-group-engine")).toHaveCount(0);
    await expect(section(page, "deepseek").getByTestId("model-group-who")).toHaveText("via Ollama (Mac mini)");
    await expect(section(page, "anthropic").getByTestId("model-group-engine")).toContainText("via Topics");

    // AC-13: «via X» on a row only when who runs it differs from the heading.
    const o4 = section(page, "openai").locator('[data-testid="model-row"][data-model="o4-mini"]');
    await expect(o4.getByTestId("model-row-via")).toHaveText("via OpenAI API");
    await expect(section(page, "anthropic").locator('[data-model="claude-opus-5-5"]').getByTestId("model-row-via")).toHaveCount(0);
    await expect(section(page, "anthropic").locator('[data-model="claude-opus-5-5"]')).toHaveAccessibleName(/Claude Code, via Topics/);

    // AC-09: Anthropic and Google whole, OpenAI at least 8 of 9, the fourth at least 5 rows.
    const anthropic = await visibleStops(page, 0);
    const openAiStops = await visibleStops(page, 1);
    const google = await visibleStops(page, 2);
    const fourth = await panel(page).locator('[data-model-column="3"]').evaluate((col) => {
      const c = col.getBoundingClientRect();
      return [...col.querySelectorAll('[data-testid="model-row"]')].filter((el) => { const r = el.getBoundingClientRect(); return r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5; }).length;
    });
    test.info().annotations.push({ type: "measure", description: JSON.stringify({ anthropic, openAiStops, google, fourth }) });
    expect(anthropic.visible).toBe(anthropic.total);
    expect(google.visible).toBe(google.total);
    expect(openAiStops.visible).toBeGreaterThanOrEqual(8);
    expect(fourth).toBeGreaterThanOrEqual(5);

    // Open the Anthropic older ones: Opus 4.8 runs on Claude Code directly.
    await section(page, "anthropic").getByTestId("model-section-older").click();
    await expect(section(page, "anthropic").locator('[data-model="claude-opus-4-8"]').getByTestId("model-row-via")).toHaveText("via Claude Code");
    const viaX = await section(page, "openai").getByTestId("model-row-via").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().left));
    expect(Math.max(...viaX) - Math.min(...viaX)).toBeLessThanOrEqual(0.5);
    await section(page, "anthropic").getByTestId("model-section-older").click();

    // AC-15: ⌄ opens a radiogroup in place, no new popover; Esc closes only it.
    const popovers = await page.locator("[data-popover]").count();
    await section(page, "anthropic").getByTestId("model-group-engine").click();
    const radios = section(page, "anthropic").getByTestId("model-group-engines");
    await expect(radios).toHaveAttribute("role", "radiogroup");
    await expect(radios.getByRole("radio")).toHaveText(["Claude Code · in Topics", "Claude API", "jcode", "OpenRouter"]);
    expect(await page.locator("[data-popover]").count()).toBe(popovers);
    await page.keyboard.press("Escape");
    await expect(radios).toHaveCount(0);
    await expect(panel(page)).toBeVisible();

    // AC-35: ← → go to the next column; Tab stops once per column.
    await section(page, "anthropic").locator('[data-model="claude-sonnet-5-5"]').focus();
    await page.keyboard.press("ArrowRight");
    expect(await page.evaluate(() => document.activeElement?.closest("[data-model-column]")?.getAttribute("data-model-column"))).toBe("1");
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.closest("[data-model-column]")?.getAttribute("data-model-column"))).toBe("2");

    // AC-34: axe on the open selector, light and dark.
    expect(await axeViolations(page), "light").toEqual([]);
    await page.emulateMedia({ colorScheme: "dark" });
    expect(await axeViolations(page), "dark").toEqual([]);
    await page.emulateMedia({ colorScheme: "light" });

    // AC-30: after a choice the closed text is the row's label, «label · who».
    await section(page, "openai").locator('[data-testid="model-row"][data-model="gpt-6.1-sol"]').click();
    await expect(page.getByTestId("provider-model-picker")).toContainText("GPT-6.1-Sol · via Codex");
  });

  test("a saved Google model does not move Google first, and its row is in view (AC-05)", async ({ page, request }) => {
    await openSelector(page, request, KEYS, "gemini-2.5-pro");
    const makers = await panel(page).getByTestId("model-column").evaluateAll((cols) => cols.map((col) => col.querySelector('[role="group"]')?.getAttribute("data-maker")));
    expect(makers).toEqual(["anthropic", "openai", "google", "meta"]);
    const chosen = section(page, "google").locator('[aria-pressed="true"]');
    await expect(chosen).toHaveCount(1);
    const [r, c] = [await chosen.boundingBox(), await panel(page).locator('[data-model-column="2"]').boundingBox()];
    expect(r!.y).toBeGreaterThanOrEqual(c!.y - 0.5);
    expect(r!.y + r!.height).toBeLessThanOrEqual(c!.y + c!.height + 0.5);
  });

  test("the 134 real jcode ids: labels stop at two lines with the whole name kept (AC-11)", async ({ page, request }) => {
    await openSelector(page, request, snapshotOf([claudeCode, row("jcode", "jcode", JCODE_IDS), engine]));
    for (const older of await panel(page).getByTestId("model-section-older").all()) await older.click();
    const labels = await panel(page).getByTestId("model-row-label").evaluateAll((els) => els.map((el) => {
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
      const button = el.closest("button")!;
      return {
        text: el.textContent ?? "", lines: Math.round(el.clientHeight / lineHeight), clamped: el.scrollHeight > el.clientHeight + 1,
        title: button.getAttribute("title"), name: button.getAttribute("aria-label") ?? "",
      };
    }));
    expect(labels.length).toBeGreaterThan(100);
    for (const label of labels) expect(label.lines, label.text).toBeLessThanOrEqual(2);
    const clamped = labels.filter((label) => label.clamped);
    test.info().annotations.push({ type: "measure", description: `clamped: ${JSON.stringify(clamped.map((l) => l.text))}` });
    expect(clamped.length).toBeLessThanOrEqual(2);
    for (const label of clamped) {
      expect(label.title).toBe(label.text);
      expect(label.name).toContain(label.text);
    }
  });

  test("gpt-oss on Ollama and on jcode is one row, and ⌄ lists both engines (AC-03)", async ({ page, request }) => {
    await openSelector(page, request, snapshotOf([
      claudeCode, row("jcode", "jcode", ["openai/gpt-oss-20b"]),
      row("direct-ollama", "Ollama (Mac mini)", ["gpt-oss:20b"], { capabilities: ["streaming"] }), engine,
    ]));
    await expect(section(page, "openai").getByTestId("model-row")).toHaveCount(1);
    await expect(section(page, "openai").getByTestId("model-row")).toContainText("GPT-OSS 20B");
    await section(page, "openai").getByTestId("model-group-engine").click();
    await expect(section(page, "openai").getByRole("radio")).toHaveText(["jcode", "Ollama (Mac mini)"]);
  });

  test("Gemini CLI ready with no models has an «Automatico» row that saves the provider alone (AC-16)", async ({ page, request }) => {
    await openSelector(page, request, snapshotOf([claudeCode, row("gemini", "Gemini CLI", []), engine]));
    const automatic = section(page, "google").getByTestId("model-row-automatic-within");
    await expect(automatic).toHaveAttribute("data-provider", "gemini");
    await automatic.click();
    await expect.poll(async () => {
      const topic = (await (await request.get("/api/topics")).json()).topics[topicId];
      return [topic.provider, topic.model ?? null];
    }).toEqual(["gemini", null]);
  });

  test("one closed text «label · who» on the chip and in the chat settings, Automatico named with who decides (AC-30, AC-31)", async ({ page, request }) => {
    const picker = await openSelector(page, request, KEYS, null, null);
    const chipLabel = page.getByTestId("provider-model-picker-label");
    // AC-31: no choice reads «Automatico · <who decides>»; the compact desktop
    // panel keeps the long sentence in aria-describedby, not on screen.
    const automatic = panel(page).getByTestId("model-row-automatic");
    const automaticText = (await automatic.innerText()).replace(/\s+/g, " ").trim();
    expect(automaticText).toMatch(/^Automatico · \S/);
    await expect(chipLabel).toHaveText(automaticText);
    const hint = await automatic.evaluate((el) => {
      const target = document.getElementById(el.getAttribute("aria-describedby") ?? "");
      return target ? { text: target.textContent ?? "", shown: target.getBoundingClientRect().width > 1 && getComputedStyle(target).clip === "auto" } : null;
    });
    expect(hint?.text).toMatch(/^Usa il predefinito: \S/);
    expect(hint?.shown).toBe(false);

    // AC-30: after a choice the closed text is the row's label, «label · who», no window.
    const o4 = section(page, "openai").locator('[data-testid="model-row"][data-model="o4-mini"]');
    const rowLabel = (await o4.getByTestId("model-row-label").innerText()).trim();
    await o4.click();
    await expect(chipLabel).toHaveText(`${rowLabel} · via OpenAI API`);
    const chipText = await chipLabel.innerText();
    expect(chipText).not.toMatch(/\d+\s?[KM]\b|≈/);

    // The chat settings write the same text for the same value.
    await page.getByTestId(`pane-tab-${topicId}`).click({ button: "right" });
    await page.getByTestId("tab-sheet").getByRole("menuitem", { name: "Impostazioni della chat" }).click();
    const trigger = page.getByTestId("topic-settings-model");
    await expect(trigger).toHaveText(chipText);
    // In the `full` variant the long sentence is on screen, under Automatico.
    await trigger.click();
    const full = page.getByTestId("topic-settings-model-popover").getByTestId("model-selector-panel");
    await expect(full).toHaveAttribute("data-variant", "full");
    const fullAutomatic = full.getByTestId("model-row-automatic");
    const fullHint = await fullAutomatic.evaluate((el) => document.getElementById(el.getAttribute("aria-describedby") ?? ""));
    expect(fullHint).not.toBeNull();
    await expect(full.locator(`[id="${await fullAutomatic.getAttribute("aria-describedby")}"]`)).toBeVisible();
    await fullAutomatic.click();
    await expect(trigger).toHaveText(automaticText);
    await expect(picker).toBeVisible();
  });

  test("the panel's text: the band says who goes direct, no «≈», nothing under 10 px, dividers visible (AC-12, AC-32, AC-36, AC-38)", async ({ page, request }) => {
    await openSelector(page, request, KEYS);
    await expect(page.getByTestId("model-selector-routing-line")).toContainText("Gli altri vanno diretti");
    for (const older of await panel(page).getByTestId("model-section-older").all()) await older.click();
    expect(await panel(page).innerText()).not.toContain("≈");
    const small = await panel(page).evaluate((root) => [...root.querySelectorAll<HTMLElement>("*")]
      .filter((el) => [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim()))
      .filter((el) => el.getBoundingClientRect().width > 1 && !el.closest(".sr-only"))
      .map((el) => ({ text: (el.textContent ?? "").trim().slice(0, 30), size: parseFloat(getComputedStyle(el).fontSize) }))
      .filter((t) => t.size < 10));
    expect(small).toEqual([]);
    // AC-38: each divider against the popover's own background, ≥ 1.25:1.
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(scheme === "dark");
      const ratios = await page.evaluate(() => {
        const pop = document.querySelector<HTMLElement>('[data-testid="provider-model-popover"]')!;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
        const paint = (...layers: string[]) => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, 1, 1);
          for (const layer of layers) { ctx.fillStyle = layer; ctx.fillRect(0, 0, 1, 1); }
          return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
        };
        const luminance = (rgb: number[]) => {
          const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
          return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
        };
        const background = getComputedStyle(pop).backgroundColor;
        return [...document.querySelectorAll<HTMLElement>('[data-model-column]')].slice(1).map((col) => {
          const [a, b] = [luminance(paint(background, getComputedStyle(col).borderLeftColor)), luminance(paint(background))];
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        });
      });
      expect(ratios.length, scheme).toBe(3);
      for (const ratio of ratios) expect(ratio, scheme).toBeGreaterThanOrEqual(1.25);
    }
  });

  test("axe at WCAG 2.1 AA: no serious or critical violation on the selector, light and dark", async ({ page, request }) => {
    await openSelector(page, request, KEYS);
    expect(await seriousViolations(page, '[data-testid="provider-model-popover"]'), "light").toEqual([]);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
    expect(await seriousViolations(page, '[data-testid="provider-model-popover"]'), "dark").toEqual([]);
  });
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
  test.describe(`desktop ${viewport.width} × ${viewport.height}, opening and room`, () => {
    test.use({ viewport });

    test("the panel opens on the roomier side of its chip, whole in the window, every heading and first row in view (AC-08, AC-10)", async ({ page, request }) => {
      const picker = await openSelector(page, request, KEYS);
      const popover = await box(page, '[data-testid="provider-model-popover"]');
      const sections = await box(page, '[data-testid="model-selector-sections"]');
      const chip = (await picker.boundingBox())!;
      test.info().annotations.push({ type: "measure", description: JSON.stringify({ popover, sections, chip }) });
      // Inside the window (8 px), on the roomier side of the chip, not over it.
      expect(popover.top).toBeGreaterThanOrEqual(8 - 0.5);
      expect(popover.bottom).toBeLessThanOrEqual(viewport.height - 8 + 0.5);
      const above = chip.y;
      const below = viewport.height - (chip.y + chip.height);
      expect(popover.top < chip.y + chip.height && popover.bottom > chip.y, "the panel covers its chip").toBe(false);
      expect(popover.bottom <= chip.y + 0.5 ? above : below).toBeGreaterThanOrEqual(Math.min(above, below));
      // Every column shows its heading and its first row without scrolling.
      for (const column of await panel(page).getByTestId("model-column").all()) {
        const c = (await column.boundingBox())!;
        for (const part of [column.getByTestId("model-section-heading").first(), column.getByTestId("model-row").first()]) {
          const r = (await part.boundingBox())!;
          expect(r.y).toBeGreaterThanOrEqual(c.y - 0.5);
          expect(r.y + r.height).toBeLessThanOrEqual(c.y + c.height + 0.5);
        }
      }
      if (viewport.width === 1024) {
        // AC-08: the column area takes most of the panel; Anthropic is whole.
        // The AC's 280 px is defined on a 400 px panel (revision §4.3), and the
        // panel is as tall as the room above this mid-screen chip, which moves
        // with the empty chat's fonts: 398 px in WebKit on the Mac, 384 in
        // Chromium on Linux (the chip 14 px higher). So the panel must take all
        // that room (§4.2) and its fixed chrome must leave 280 of 400, that is
        // at most 120 px, so a panel of 400 or more has 280 px of columns.
        expect(popover.height).toBeGreaterThanOrEqual(Math.min(456, Math.max(above, below) - 16) - 1);
        expect(popover.height - sections.height).toBeLessThanOrEqual(400 - 280);
        expect(sections.height / popover.height).toBeGreaterThanOrEqual(0.7);
        const anthropic = await visibleStops(page, 0);
        expect(anthropic.visible).toBe(anthropic.total);
      }
    });

    test("no label of the fixture is cut, none takes more than two lines (AC-11)", async ({ page, request }) => {
      await openSelector(page, request, KEYS);
      for (const older of await panel(page).getByTestId("model-section-older").all()) await older.click();
      const labels = await panel(page).getByTestId("model-row-label").evaluateAll((els) => els.map((el) => ({
        text: el.textContent ?? "",
        lines: Math.round(el.clientHeight / parseFloat(getComputedStyle(el).lineHeight)),
        clamped: el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1,
      })));
      expect(labels.length).toBeGreaterThan(30);
      expect(labels.filter((label) => label.clamped).map((label) => label.text)).toEqual([]);
      for (const label of labels) expect(label.lines, label.text).toBeLessThanOrEqual(2);
    });

    test("axe finds no violation of the five rules on the open selector, light and dark (AC-34)", async ({ page, request }) => {
      await openSelector(page, request, KEYS);
      await shot(page, `selector-${viewport.width}-light`);
      expect(await axeViolations(page), "light").toEqual([]);
      await page.emulateMedia({ colorScheme: "dark" });
      await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
      await shot(page, `selector-${viewport.width}-dark`);
      expect(await axeViolations(page), "dark").toEqual([]);
    });
  });
}

test.describe("without keys, 1440 × 900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("connect boxes list only the snapshot's providers, «Accedi» acts at once, «Non mi serve» hides (AC-17..19)", async ({ page, request }) => {
    // Catch the terminal event before the app hears it: the test server must
    // not open a shell. The detail is what «Accedi» would have typed.
    await page.addInitScript(() => {
      window.addEventListener("topics:open-terminal-with-command", (event) => {
        (window as unknown as { __terminal: unknown[] }).__terminal = [...((window as unknown as { __terminal?: unknown[] }).__terminal ?? []), (event as CustomEvent).detail];
        event.stopImmediatePropagation();
      });
      // Once per test, not on the reload that must find the box still hidden.
      if (!sessionStorage.getItem("msel-clean")) {
        localStorage.removeItem("topics.modelSelector.hiddenConnect");
        sessionStorage.setItem("msel-clean", "1");
      }
    });
    await openSelector(page, request, NO_KEYS);
    const text = (await panel(page).innerText()).replace(/\s+/g, " ");
    for (const word of ["login", "export", "ECONNREFUSED"]) expect(text).not.toMatch(new RegExp(`(^|[^\\p{L}])${word}([^\\p{L}]|$)`, "iu"));
    await expect(section(page, "openai").getByTestId("model-connect-action")).toHaveCount(1);
    await expect(section(page, "openai").getByTestId("model-connect-codex")).toContainText("Codex · Da collegare");
    await expect(section(page, "google").getByTestId("model-connect-action")).toHaveAttribute("data-provider", "gemini");
    await expect(section(page, "google").getByTestId("model-connect-action")).toHaveText("Configura ›");
    await expect(panel(page).locator('[role="group"]')).toHaveCount(3);

    await section(page, "openai").getByTestId("model-connect-action").click();
    await expect(panel(page)).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __terminal: unknown[] }).__terminal)).toEqual([{ command: "codex login" }]);

    await page.getByTestId("provider-model-picker").click();
    await section(page, "openai").getByTestId("model-connect-hide").click();
    await expect(section(page, "openai")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.reload();
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    await page.getByTestId("provider-model-picker").click();
    await expect(panel(page)).toBeVisible();
    await expect(section(page, "openai")).toHaveCount(0);
    await expect(section(page, "google")).toBeVisible();
  });
});

test.describe("phone 390 × 844", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("every target of the sheet is at least 44 × 44 (AC-37)", async ({ page, request }) => {
    await openSelector(page, request, KEYS);
    await expect(panel(page)).toHaveAttribute("data-layout", "list");
    const small = await panel(page).locator('button, input[type="search"]').evaluateAll((els) => els
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => { const r = el.getBoundingClientRect(); return { id: el.getAttribute("data-testid") ?? el.textContent?.slice(0, 20), w: Math.round(r.width), h: Math.round(r.height) }; })
      .filter((t) => t.w < 44 || t.h < 44));
    expect(small).toEqual([]);
  });

  test("axe finds no violation of the five rules on the sheet, light and dark (AC-34)", async ({ page, request }) => {
    await openSelector(page, request, KEYS);
    await shot(page, "selector-phone-light");
    expect(await axeViolations(page), "light").toEqual([]);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
    await shot(page, "selector-phone-dark");
    expect(await axeViolations(page), "dark").toEqual([]);
  });

  test("holding the chat's name opens the chat settings, whose model trigger opens a sheet from the bottom, and Escape goes back to them (AC-39)", async ({ page, request, browserName }) => {
    await openSelector(page, request, KEYS);
    await page.keyboard.press("Escape");
    await expect(panel(page)).toHaveCount(0);
    // The title opens the chat's sheet from the bottom (TABSHEET-04).
    const item = page.getByTestId("tab-sheet").getByRole("menuitem", { name: "Impostazioni della chat" });
    // WebKit has no `Touch` constructor, so there the hold is the `contextmenu`
    // that `useLongPress` itself dispatches; Chromium holds a real finger.
    if (browserName === "webkit") await page.getByTestId("mobile-pane-title").dispatchEvent("contextmenu");
    else await longPress(page, '[data-testid="mobile-pane-title"]', { until: item });
    await item.click();
    const trigger = page.getByTestId("topic-settings-model");
    await expect(trigger).toHaveText(/^.+ · .+$/);
    await trigger.click();
    const sheet = page.getByTestId("topic-settings-model-popover");
    await expect(sheet.getByTestId("model-selector-panel")).toHaveAttribute("data-layout", "list");
    const r = (await sheet.boundingBox())!;
    expect(Math.round(r.width)).toBe(390);
    expect(Math.round(r.y + r.height)).toBeGreaterThanOrEqual(840);
    // The long sentence of Automatico is on the first line of the phone.
    const automatic = sheet.getByTestId("model-row-automatic");
    await expect(sheet.locator(`[id="${await automatic.getAttribute("aria-describedby")}"]`)).toBeVisible();
    // Escape closes the sheet only: the settings are still there, on the trigger.
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(trigger).toBeVisible();
    await expect(trigger).toBeFocused();
  });
});

/** Claude Code the default, Gemini CLI ready with no model of its own (AC-16). */
const GEMINI_EMPTY = snapshotOf([claudeCode, row("gemini", "Gemini CLI", []), engine]);
/** The fixture with the 134 ids jcode really lists. */
const REAL_KEYS = snapshotOf(KEYS.providers.map((entry) => (entry.name === "jcode" ? row("jcode", "jcode", JCODE_IDS) : entry)));

const savedChoice = async (request: Parameters<typeof resetPaneStore>[0]) => {
  const topic = (await (await request.get("/api/topics")).json()).topics[topicId];
  return [topic.provider ?? null, topic.model ?? null];
};
const describedText = (button: ReturnType<Page["getByTestId"]>) =>
  button.evaluate((el) => document.getElementById(el.getAttribute("aria-describedby") ?? "")?.textContent ?? null);

/** The box once two reads in a row agree: `Menu` places the panel again when its size settles. */
async function settledBox(page: Page, selector: string) {
  let last = "";
  await expect.poll(async () => {
    const now = JSON.stringify(await box(page, selector));
    const same = now === last;
    last = now;
    return same;
  }, { intervals: [50, 100, 100, 200] }).toBe(true);
  return box(page, selector);
}

async function openChatSettings(page: Page) {
  await page.getByTestId(`pane-tab-${topicId}`).click({ button: "right" });
  await page.getByTestId("tab-sheet").getByRole("menuitem", { name: "Impostazioni della chat" }).click();
  const trigger = page.getByTestId("topic-settings-model");
  await trigger.waitFor({ state: "visible" });
  return trigger;
}

test.describe("Automatico, named with the app's default (revision §3.7)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("on a chat on Codex the composer's Automatico names the default, and pressing it keeps that name", async ({ page, request }) => {
    await openSelector(page, request, KEYS, "gpt-6.1-sol", "codex");
    const automatic = panel(page).getByTestId("model-row-automatic");
    await expect(automatic).toHaveAttribute("aria-pressed", "false");
    await expect(automatic).toHaveText("Automatico · Claude Code");
    expect(await describedText(automatic)).toBe("Usa il predefinito: Claude Code");
    await automatic.click();
    await expect.poll(() => savedChoice(request)).toEqual([null, null]);
    await expect(page.getByTestId("provider-model-picker-label")).toHaveText("Automatico · Claude Code");
  });

  test("on a chat on Codex the chat settings' Automatico names the default, and Save writes it", async ({ page, request }) => {
    await openSelector(page, request, KEYS, "gpt-6.1-sol", "codex");
    await page.keyboard.press("Escape");
    const trigger = await openChatSettings(page);
    await trigger.click();
    const full = page.getByTestId("topic-settings-model-popover").getByTestId("model-selector-panel");
    const automatic = full.getByTestId("model-row-automatic");
    await expect(automatic).toHaveText("Automatico · Claude Code");
    expect(await describedText(automatic)).toBe("Usa il predefinito: Claude Code");
    await automatic.click();
    await expect(trigger).toHaveText("Automatico · Claude Code");
  });

  test("a chat on an engine with no model of its own: the chip names it, its row is the pressed one, not Automatico", async ({ page, request }) => {
    await openSelector(page, request, GEMINI_EMPTY, null, "gemini");
    await expect(page.getByTestId("provider-model-picker-label")).toHaveText("Automatico · Gemini CLI");
    await expect(section(page, "google").getByTestId("model-row-automatic-within")).toHaveAttribute("aria-pressed", "true");
    const automatic = panel(page).getByTestId("model-row-automatic");
    await expect(automatic).toHaveAttribute("aria-pressed", "false");
    await expect(automatic).toHaveText("Automatico · Claude Code");
  });

  test("a chat on Gemini CLI with no model: the top Automatico is not the choice and says who it would be", async ({ page, request }) => {
    await openSelector(page, request, KEYS, null, "gemini");
    await expect(page.getByTestId("provider-model-picker-label")).toHaveText("Automatico · Gemini CLI");
    const automatic = panel(page).getByTestId("model-row-automatic");
    await expect(automatic).toHaveAttribute("aria-pressed", "false");
    await expect(automatic).toHaveText("Automatico · Claude Code");
  });

  test("a new chat keeps «Automatico» within an engine, with no PATCH to the draft", async ({ page, request }) => {
    await resetPaneStore(request, []);
    await mockSnapshot(page, GEMINI_EMPTY);
    await goToApp(page);
    await page.keyboard.press("Escape");
    const draftPatches: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "PATCH" && /\/api\/topics\/draft(%3A|:)/.test(req.url())) draftPatches.push(req.url());
    });
    await page.getByTestId("pane-add-menu-trigger").first().click();
    await page.getByTestId("pane-add-menu").getByTestId("pane-add-menu-new-chat").click();
    const picker = page.getByTestId("provider-model-picker").last();
    await picker.waitFor({ state: "visible", timeout: 10_000 });
    await picker.click();
    await section(page, "google").getByTestId("model-row-automatic-within").click();
    await expect(panel(page)).toHaveCount(0);
    await expect(picker.getByTestId("provider-model-picker-label")).toHaveText("Automatico · Gemini CLI");
    await picker.click();
    await expect(section(page, "google").getByTestId("model-row-automatic-within")).toHaveAttribute("aria-pressed", "true");
    await expect(panel(page).getByTestId("model-row-automatic")).toHaveAttribute("aria-pressed", "false");
    expect(draftPatches).toEqual([]);
  });

  test("the heading's engine choice works from the keyboard: arrows move between the engines, Enter picks (MSEL-08)", async ({ page, request }) => {
    await openSelector(page, request, KEYS, "claude-opus-5-5", "claude-code");
    const engineButton = section(page, "anthropic").getByTestId("model-group-engine");
    await engineButton.focus();
    await page.keyboard.press("Enter");
    const radios = section(page, "anthropic").getByRole("radio");
    await expect(radios).toHaveText(["Claude Code · in Topics", "Claude API", "jcode", "OpenRouter"]);
    await expect(radios.nth(0)).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(radios.nth(1)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(radios.nth(3)).toBeFocused();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    await expect(radios.nth(1)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(section(page, "anthropic").getByTestId("model-group-engines")).toHaveCount(0);
    await expect(panel(page)).toBeVisible();
    await expect(engineButton).toBeFocused();
    await expect(engineButton).toContainText("via Claude API");
    await expect.poll(() => savedChoice(request)).toEqual(["claude", "claude-opus-5-5"]);
  });
});

test.describe("desktop 1024 × 768, the chat settings' selector (AC-01, AC-10)", () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  for (const [name, snapshot] of [["the fixture", KEYS], ["the 134 real jcode ids", REAL_KEYS]] as const) {
    test(`at every opening the panel stays under its ceiling, in the window and off its trigger (${name})`, async ({ page, request }) => {
      await openSelector(page, request, snapshot);
      await page.keyboard.press("Escape");
      const trigger = await openChatSettings(page);
      for (let opening = 1; opening <= 4; opening++) {
        await trigger.click();
        const popover = page.getByTestId("topic-settings-model-popover");
        await expect(popover.getByTestId("model-selector-panel")).toBeVisible();
        const r = await settledBox(page, '[data-testid="topic-settings-model-popover"]');
        const t = (await trigger.boundingBox())!;
        const body = await popover.getByTestId("model-selector-panel").evaluate((el) => {
          const style = getComputedStyle(el.parentElement!.parentElement!);
          return { min: parseFloat(style.minHeight) || 0, max: parseFloat(style.maxHeight) };
        });
        test.info().annotations.push({ type: "measure", description: JSON.stringify({ opening, r, t, body }) });
        expect(body.min, `opening ${opening}: min-height over max-height`).toBeLessThanOrEqual(body.max);
        expect(r.height, `opening ${opening}`).toBeLessThanOrEqual(456 + 0.5);
        expect(r.top, `opening ${opening}`).toBeGreaterThanOrEqual(8 - 0.5);
        expect(r.bottom, `opening ${opening}`).toBeLessThanOrEqual(768 - 8 + 0.5);
        expect(r.top < t.y + t.height && r.bottom > t.y, `opening ${opening}: the panel covers its trigger`).toBe(false);
        await page.keyboard.press("Escape");
        await expect(popover).toHaveCount(0);
      }
    });
  }
});

test.describe("a window that shrinks with the panel open", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the panel shrinks with it and stays in the window", async ({ page, request }) => {
    await openSelector(page, request, KEYS);
    await page.setViewportSize({ width: 1440, height: 560 });
    await expect.poll(async () => (await box(page, '[data-testid="provider-model-popover"]')).bottom).toBeLessThanOrEqual(560 - 8 + 0.5);
    const r = await box(page, '[data-testid="provider-model-popover"]');
    expect(r.top).toBeGreaterThanOrEqual(8 - 0.5);
    await expect(page.getByTestId("ai-selector-providers")).toBeInViewport({ ratio: 1 });
  });
});
