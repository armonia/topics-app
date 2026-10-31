/**
 * @covers COMPOSER-BAR-01
 * Card 067a1f5b: the session controls sit in a low bar OUTSIDE (below) the composer
 * card, and the form keeps an 8px margin, so the card ends close to the window bottom.
 */
import { expect, test, type WebSocketRoute } from "@playwright/test";
import { goToApp, openTopic } from "./helpers";
import { createTopic, deleteTopic, resetPaneStore } from "./helpers/api-fixtures";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);

test.describe("composer controls bar", () => {
  let topicId = "";
  const topicName = `controls-bar-${Date.now()}`;

  test.beforeAll(async ({ request }) => {
    topicId = (await createTopic(request, topicName)).id;
  });
  test.afterAll(async ({ request }) => {
    if (topicId) await deleteTopic(request, topicId);
  });
  test.beforeEach(async ({ request }) => {
    await resetPaneStore(request, [topicId]);
  });

  test("controls sit OUTSIDE the card in a low band, effort always visible", async ({ page }) => {
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    const card = page.getByTestId("composer-card");
    const bar = page.getByTestId("composer-controls");
    await expect(bar).toBeVisible();
    const [cardBox, barBox, area] = [
      await card.boundingBox(),
      await bar.boundingBox(),
      await page.getByTestId("chat-input-area").boundingBox(),
    ];
    expect(cardBox && barBox && area).toBeTruthy();
    // The bar is below the card's border, not inside it.
    expect(barBox!.y).toBeGreaterThanOrEqual(cardBox!.y + cardBox!.height - 0.5);
    // The band under the field was 50px (12 margin + 6 padding + 32 bar); now lower.
    const band = area!.y + area!.height - (cardBox!.y + cardBox!.height);
    expect(band).toBeLessThanOrEqual(44);
    // The current effort shows in the bar without opening any menu.
    await expect(bar.getByTestId("session-effort-badge")).toBeVisible();
  });

  test("effort chip reads AUTO when the provider snapshot has no tier", async ({ page }) => {
    // Strip every effortTier so the chat cannot resolve one from the provider.
    type Snap = { providers?: Array<Record<string, unknown>> };
    const withoutTier = (snapshot: Snap): Snap => ({
      ...snapshot,
      providers: (snapshot.providers ?? []).map((p) => ({ ...p, effortTier: null })),
    });
    await page.route("**/api/providers/snapshot", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: withoutTier((await response.json()) as Snap) });
    });
    await page.routeWebSocket(/\/ws(?:\?|$)/, (socket: WebSocketRoute) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        if (typeof message === "string" && message.includes('"providers:snapshot"')) {
          const frame = JSON.parse(message) as { snapshot?: Snap };
          if (frame.snapshot) frame.snapshot = withoutTier(frame.snapshot);
          socket.send(JSON.stringify(frame));
        } else socket.send(message);
      });
      socket.onMessage((message) => server.send(message));
    });
    await goToApp(page);
    await page.keyboard.press("Escape");
    await openTopic(page, new RegExp(topicName));
    const badge = page.getByTestId("composer-controls").getByTestId("session-effort-badge");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText(/auto/i);
  });
});
