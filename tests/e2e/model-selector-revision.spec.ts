/**
 * THE MODEL SELECTOR OF THE REVISION OF 2026-10-04, ON THE AUDIT FLEET.
 *
 * openspec/changes/model-selector/revision-2026-10-04.md §11: the fixture of
 * the audit «with keys» (Claude Code, Claude API, Codex, OpenAI API, Gemini
 * CLI, jcode, an Ollama and an OpenRouter endpoint, goose in error) and
 * «without keys», plus the 134 ids jcode really lists. The snapshot is handed
 * in through the route and the WS push; no provider is called.
 *
 * @covers MSEL-02 MSEL-04 MSEL-05 MSEL-08 AICTRL-02
 */
import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import type { AxeResults } from "axe-core";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";
import type { ProvidersSnapshot } from "../../shared/types";
import { JCODE_IDS, KEYS, NO_KEYS, claudeCode, engine, mockSnapshot, row, snapshotOf } from "./fixtures/model-panels-fleet";

hermetic(test);

let topicId = "";
let topicName = "";
test.beforeAll(async ({ request }) => {
  topicName = `Model selector revision ${Date.now()}`;
  topicId = (await createTopic(request, topicName)).id;
});
test.afterAll(async ({ request }) => {
  if (topicId) await deleteTopic(request, topicId);
});

async function openSelector(page: Page, request: Parameters<typeof resetPaneStore>[0], snapshot: ProvidersSnapshot, model: string | null = null) {
  await request.patch(`/api/topics/${topicId}`, { data: { provider: model ? (model.startsWith("gemini") ? "gemini" : "claude-code") : "claude-code", model, topicsRouting: true } });
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
});

test.describe("desktop 1024 × 768", () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test("the column area takes most of the panel, and the panel never covers its chip (AC-08, AC-10)", async ({ page, request }) => {
    const picker = await openSelector(page, request, KEYS);
    const popover = await box(page, '[data-testid="provider-model-popover"]');
    const sections = await box(page, '[data-testid="model-selector-sections"]');
    const chip = (await picker.boundingBox())!;
    test.info().annotations.push({ type: "measure", description: JSON.stringify({ popover, sections, chip }) });
    expect(sections.height).toBeGreaterThanOrEqual(280);
    expect(sections.height / popover.height).toBeGreaterThanOrEqual(0.7);
    const anthropic = await visibleStops(page, 0);
    expect(anthropic.visible).toBe(anthropic.total);
    // Inside the window (8 px), on the roomier side of the chip, not over it.
    expect(popover.top).toBeGreaterThanOrEqual(8 - 0.5);
    expect(popover.bottom).toBeLessThanOrEqual(768 - 8 + 0.5);
    const above = chip.y;
    const below = 768 - (chip.y + chip.height);
    const overlaps = popover.top < chip.y + chip.height && popover.bottom > chip.y;
    expect(overlaps).toBe(false);
    if (popover.bottom <= chip.y) expect(above).toBeGreaterThanOrEqual(Math.min(below, popover.height));
  });
});

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
});
