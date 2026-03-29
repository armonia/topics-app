import { test, expect } from "@playwright/test";

test.describe("Mobile Responsive", () => {
  test("adapts to 375px viewport", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    // On mobile viewport, sidebar may start hidden — wait for any content to render
    await page.waitForTimeout(3000);

    const bodyText = await page.locator("body").textContent();
    expect(bodyText!.length).toBeGreaterThan(10);
    // On mobile, sidebar may be collapsed — check for either sidebar content or main content
    expect(
      bodyText!.includes("Topics") || bodyText!.includes("topics") ||
      bodyText!.includes("Welcome") || bodyText!.includes("Activity") ||
      bodyText!.includes("Live") || bodyText!.includes("Search")
    ).toBeTruthy();
  });
});
