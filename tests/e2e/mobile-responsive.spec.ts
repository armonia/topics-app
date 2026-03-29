import { test, expect } from "@playwright/test";

test.describe("Mobile Responsive", () => {
  test("adapts to 375px viewport", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/", { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);

    const bodyText = await page.locator("body").textContent();
    expect(bodyText!.length).toBeGreaterThan(10);
    expect(bodyText!.includes("Topics") || bodyText!.includes("topics")).toBeTruthy();

    // Try to find sidebar toggle
    const toggleBtn = page.getByRole("button", { name: /Toggle sidebar/i });
    if (await toggleBtn.count() > 0) {
      await toggleBtn.click();
      await page.waitForTimeout(500);
    }
  });
});
