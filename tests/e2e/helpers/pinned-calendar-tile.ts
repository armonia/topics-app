import { type Page } from "@playwright/test";
import { E2E_BASE } from "./test-server";

/** Shared fixture ids/urls for the pinned-calendar-tile-preview specs (card 25775e23). */
export const CAL_CTX_ID = "e2e-cal-ctx-1";
export const CAL_PANE_ID = `browser:${CAL_CTX_ID}`;
export const CAL_URL = "https://calendar.google.com/calendar/render";

export async function setPins(page: Page, ids: string[]): Promise<void> {
  await page.request.put(`${E2E_BASE}/api/ui-state/sidebar-state`, {
    data: {
      viewMode: "timeline",
      showArchived: false,
      expandedNodes: [],
      pinnedItems: ids,
      pinnedLayout: [{ keys: ids, widths: ids.map(() => 1 / ids.length) }],
    },
  });
}

export async function gotoSidebar(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: "visible", timeout: 15000 });
}

export function calendarTile(page: Page) {
  return page.getByTestId("sidebar-pinned-section").getByTestId("pinned-tile").first();
}
