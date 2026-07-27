/**
 * dnd-kit drag-and-drop helpers for Playwright E2E tests.
 *
 * dnd-kit uses pointer events (not HTML5 DnD), so Playwright's built-in
 * locator.dragTo() silently fails. These helpers use manual page.mouse
 * methods with intermediate steps for proper activation and collision detection.
 *
 * CONVENTION: No waitForTimeout() usage. Mouse move steps provide timing.
 */
import type { Page, Locator } from "@playwright/test";

/**
 * Drag within a vertical sortable list to reorder items.
 * Offsets the target position to place above or below the target element.
 */
export async function dndReorder(
  page: Page,
  source: Locator,
  target: Locator,
  position: "above" | "below" = "below"
) {
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox) throw new Error("Source not visible for reorder");
  if (!targetBox) throw new Error("Target not visible for reorder");

  const offsetY = position === "above" ? -5 : targetBox.height + 5;
  const adjustedTargetX = targetBox.x + targetBox.width / 2;
  const adjustedTargetY = targetBox.y + offsetY;

  const startX = sourceBox.x + sourceBox.width / 2;
  const startY = sourceBox.y + sourceBox.height / 2;

  // Move to source center and press
  await page.mouse.move(startX, startY);
  await page.mouse.down();

  // Small initial move to pass dnd-kit activation threshold
  await page.mouse.move(startX + 5, startY + 5, { steps: 3 });

  // Move to adjusted target position
  await page.mouse.move(adjustedTargetX, adjustedTargetY, { steps: 10 });

  // Final hover for drop zone registration
  await page.mouse.move(adjustedTargetX, adjustedTargetY);

  await page.mouse.up();
}
