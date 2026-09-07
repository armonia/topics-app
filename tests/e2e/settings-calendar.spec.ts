/**
 * The Calendar card of Settings, driven by a finger and answered by a real feed.
 *
 * WHAT WAS UNCOVERED. The server half of the calendar has three unit suites
 * (`server/routes/calendar.test.ts`, `services/calendar-feed.test.ts`,
 * `services/ical.test.ts`); the panel that a person actually uses had zero
 * lines about it anywhere under `tests/`. Its five testids
 * (`calendar-feed-url`, `-test`, `-save`, `-probe`, `-forget`) appeared in no
 * test at all, so the whole path from typing an address to storing it was held
 * up by nothing.
 *
 * WHY A REAL HTTP SERVER AND NOT `page.route`. The feed is fetched by the
 * SERVER (`services/calendar-feed.ts`), not by the page: intercepting in the
 * browser would intercept a request that is never made there, and the test
 * would pass while proving that the interception was ignored. So this file
 * raises a plain HTTP server on a free port of the loopback and hands the
 * panel its address, which is also the closest thing to what a person does.
 *
 * THE ORDER IS THE POINT. You probe BEFORE you save: a wrong address answers
 * with the reason and nothing is stored (the first typo would otherwise be
 * written), a good one answers with the calendar's own name and how many
 * events the week holds. Saving is what turns the sync on; forgetting takes
 * the address off the machine.
 *
 * @covers CAL-01, CAL-05
 */
import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { hermetic } from "./fixtures/hermetic";
import { E2E_BASE } from "./helpers/test-server";

hermetic(test);

const HOST = "127.0.0.1";
const CALENDAR_NAME = "Topics QA";

/**
 * A feed with one event that is always in the next few hours.
 *
 * The date is computed, not written down: the probe counts what falls inside
 * the default horizon starting from NOW, so a fixed date would make this spec
 * report zero events on the day it goes past - a test that starts lying on a
 * calendar page, of all places.
 */
function feed(): string {
  const start = new Date(Date.now() + 2 * 3_600_000);
  const end = new Date(start.getTime() + 3_600_000);
  const stamp = (d: Date) => `${d.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `X-WR-CALNAME:${CALENDAR_NAME}`,
    "BEGIN:VEVENT",
    "UID:one@topics.test",
    "SUMMARY:Design review",
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    // Anything other than the one path answers 404, which is what the failing
    // probe of the first step needs: an address that resolves and refuses.
    if (req.url !== "/basic.ics") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("no calendar here");
      return;
    }
    res.writeHead(200, { "content-type": "text/calendar; charset=utf-8", "cache-control": "no-store" });
    res.end(feed());
  });
  await new Promise<void>((ready) => server.listen(0, HOST, ready));
  origin = `http://${HOST}:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((closed) => server.close(() => closed()));
});

/**
 * The same door the other settings specs use: Cmd+comma once the sidebar is
 * there. The keystroke is repeated until the panel answers, because the
 * shortcut is listened for by an effect of the mounted app and one sent to a
 * freshly loaded document falls into the void.
 */
async function openCalendarSettings(page: Page) {
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 20_000 });
  const panel = page.getByTestId("settings-panel");
  await expect(async () => {
    await page.keyboard.press("Meta+Comma");
    await expect(panel).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  // The panel opens with a scale animation; clicking a nav entry through it is
  // fine, but the assertions below read state, so we wait for the fact rather
  // than for a delay.
  await expect
    .poll(() => panel.evaluate((el) => getComputedStyle(el).transform), { timeout: 5_000 })
    .toBe("none");
  await panel.locator("nav").first().getByRole("button", { name: "Calendario", exact: true }).click();
  return panel;
}

/** What the server has stored, which is the only place the address really is. */
async function storedFeedUrl(page: Page): Promise<string | null> {
  const res = await page.request.get(`${E2E_BASE}/api/app-settings`);
  const body = (await res.json()) as { settings?: { calendarFeedUrl?: string | null } };
  return body.settings?.calendarFeedUrl ?? null;
}

test("CALUI-01: si prova l'indirizzo, poi si salva, e dimenticarlo lo toglie dalla macchina", async ({ page }) => {
  test.info().annotations.push({ type: "spec", description: "CAL-01" });
  await page.goto("/");
  const panel = await openCalendarSettings(page);

  const field = panel.getByTestId("calendar-feed-url");
  const probe = panel.getByTestId("calendar-probe");
  const forget = panel.getByTestId("calendar-forget");

  // Nothing configured yet: no address to forget.
  await expect(field).toHaveValue("");
  await expect(forget).toHaveCount(0);
  expect(await storedFeedUrl(page)).toBeNull();

  // 1. An address that answers 404 is refused BY THE PROBE, and nothing is
  //    written: this is the whole reason the probe button exists next to save.
  await field.fill(`${origin}/nope.ics`);
  await panel.getByTestId("calendar-test").click();
  await expect(probe).toContainText("404");
  expect(await storedFeedUrl(page)).toBeNull();

  // 2. The real feed answers with the calendar's OWN name and a count of
  //    events - both come back from the server having actually read it.
  await field.fill(`${origin}/basic.ics`);
  await panel.getByTestId("calendar-test").click();
  await expect(probe).toContainText(CALENDAR_NAME);
  await expect(probe).toContainText("1 eventi");

  // 3. Saving stores the address and turns the sync on. The field empties,
  //    because the secret does not come back from the server: what the panel
  //    shows afterwards is THAT one is set, not which.
  await panel.getByTestId("calendar-save").click();
  await expect(forget).toBeVisible();
  await expect(field).toHaveValue("");
  await expect.poll(() => storedFeedUrl(page), { timeout: 5_000 }).toBe(`${origin}/basic.ics`);

  // 4. Forgetting is the way out, and it reaches the server: the address is
  //    gone from the machine, not just from the field.
  await forget.click();
  await expect(forget).toHaveCount(0);
  await expect(field).toHaveValue("");
  await expect.poll(() => storedFeedUrl(page), { timeout: 5_000 }).toBeNull();
});
