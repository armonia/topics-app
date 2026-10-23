/**
 * inp-shell.spec.ts: how long the app takes to answer the interactions a
 * person repeats all day, read the way the browser reads them (Event Timing).
 *
 * WHAT IT DRIVES. Trusted input, not synthetic events (Event Timing reports
 * neither): switching between two chats, typing into the composer, opening and
 * closing the menu of the chrome. Several dozen interactions, enough for a
 * percentile to mean something.
 *
 * WHAT IT READS. Its OWN observer, installed before the bundle: the page's
 * `PerformanceObserver({ type: "event", durationThreshold: 16 })` and the
 * browser's own count of interactions (`performance.interactionCount`). It
 * does not read the app's module (`client/src/lib/eventTiming.ts`), so a bug in
 * that module cannot make this measurement look good. The arithmetic of the
 * histogram and of the percentile is the one the desktop shell reports with
 * (`shared/interaction-histogram.ts`).
 *
 * THIS FILE DOES NOT JUDGE. It writes `test-results/inp-shell.json` and asserts
 * only that the HARNESS worked. The budget is recorded in
 * `scripts/inp-shell-baseline.json` and compared by exactly one thing,
 * `scripts/check-inp-shell.ts`.
 *
 * ENGINE, NOT SHELL. This is WebKit driven by Playwright: the engine of the
 * desktop shell, not the shell. The p95 of the shell itself comes from its own
 * reports into the server log (`--source=shell`).
 *
 * @covers INTERACTION-01
 */
import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { addInteraction, emptyInteractionHistogram, interactionPercentile } from "../../shared/interaction-histogram";
import { hermetic } from "./fixtures/hermetic";
import { goToApp } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { openProfileMenu } from "./helpers/open-perf-panel";

hermetic(test);

const OUT_PATH = resolve(__dirname, "../../test-results/inp-shell.json");
/** Round trips between the two chats. */
const SWITCHES = 12;
/** Keys typed into the composer, one interaction each. */
const KEYS = "Typing a line of text into the composer";
/** Openings of the menu of the chrome. */
const MENU_OPENINGS = 5;

/** `interactionCount` is not in the DOM typings of this TypeScript yet. */
type CountingPerformance = Performance & { interactionCount?: number };

interface InteractionWindow {
  __inp: { entries: Array<[number, string, number]>; supported: boolean };
}

test.describe("INP — the interactions a person repeats all day", () => {
  test.describe.configure({ timeout: 180_000 });

  test("records how long each took", async ({ page, request }) => {
    const stamp = Date.now();
    const topics = [await createTopic(request, `E2E-Inp-A-${stamp}`), await createTopic(request, `E2E-Inp-B-${stamp}`)];
    try {
      await resetPaneStore(request, topics.map((t) => t.id));
      await page.addInitScript(() => {
        const state: InteractionWindow["__inp"] = { entries: [], supported: false };
        (window as unknown as InteractionWindow).__inp = state;
        const kinds = typeof PerformanceObserver !== "undefined" ? PerformanceObserver.supportedEntryTypes : [];
        state.supported = kinds.includes("event") && typeof (performance as CountingPerformance).interactionCount === "number";
        if (!state.supported) return;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as unknown as Array<PerformanceEntry & { interactionId?: number }>) {
            state.entries.push([entry.interactionId ?? 0, entry.name, entry.duration]);
          }
        }).observe({ type: "event", durationThreshold: 16, buffered: true } as PerformanceObserverInit);
      });
      await goToApp(page);
      await page.keyboard.press("Escape");

      const pane = (id: string) => page.locator(`[data-pane-id="${id}"]`).first();
      const [a, b] = topics as [(typeof topics)[number], (typeof topics)[number]];
      // Both chats opened once before counting: opening a chat for the first
      // time is a different and dearer thing than switching between two.
      for (const t of [a, b, a]) {
        await pane(t.id).click();
        await expect(page.locator(`[data-testid="chat-panel"][aria-label="${t.name} panel"]`).first()).toBeVisible({ timeout: 20_000 });
      }

      for (let i = 0; i < SWITCHES; i++) {
        const to = i % 2 === 0 ? b : a;
        await pane(to.id).click();
        await expect(page.locator(`[data-testid="chat-panel"][aria-label="${to.name} panel"]`).first()).toBeVisible({ timeout: 20_000 });
      }

      const composer = page
        .locator(`[data-testid="chat-panel"][aria-label="${a.name} panel"]`)
        .first()
        .getByRole("textbox", { name: `Campo del messaggio per ${a.name}` });
      await pane(a.id).click();
      await expect(composer).toBeVisible({ timeout: 20_000 });
      await composer.click();
      await composer.pressSequentially(KEYS, { delay: 25 });
      await composer.fill("");

      for (let i = 0; i < MENU_OPENINGS; i++) {
        await openProfileMenu(page);
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("sidebar-system-menu")).toHaveCount(0, { timeout: 10_000 });
      }

      const read = await page.evaluate(() => ({
        supported: (window as unknown as InteractionWindow).__inp.supported,
        entries: (window as unknown as InteractionWindow).__inp.entries,
        interactions: (performance as CountingPerformance).interactionCount ?? 0,
      }));

      // One interaction is several entries (pointerdown, pointerup, click):
      // it lasted as long as the longest of them.
      const worstByInteraction = new Map<number, number>();
      for (const [id, , duration] of read.entries) {
        if (id > 0) worstByInteraction.set(id, Math.max(worstByInteraction.get(id) ?? 0, duration));
      }
      const histogram = emptyInteractionHistogram();
      let worstMs = 0;
      for (const duration of worstByInteraction.values()) {
        addInteraction(histogram, duration);
        worstMs = Math.max(worstMs, duration);
      }
      const slow = histogram.reduce((sum, n) => sum + n, 0);

      mkdirSync(resolve(__dirname, "../../test-results"), { recursive: true });
      writeFileSync(
        OUT_PATH,
        `${JSON.stringify(
          {
            $schema: "inp-shell-v1",
            measuredAt: new Date().toISOString(),
            supported: read.supported,
            interactions: read.interactions,
            slow,
            p95Ms: read.supported ? interactionPercentile(histogram, read.interactions, 0.95) : null,
            worstMs,
            histogram,
          },
          null,
          2,
        )}\n`,
      );

      // Harness sanity ONLY. An engine without Event Timing writes
      // `supported: false` and the gate abstains; an engine WITH it that counted
      // nothing means the driving did not reach the app.
      if (read.supported) expect(read.interactions, "the driving produced no interaction the browser counted").toBeGreaterThan(0);
    } finally {
      for (const t of topics) await deleteTopic(request, t.id).catch(() => {});
    }
  });
});
