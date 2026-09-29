import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Open a project by clicking its sidebar button, then wait for the project
 * window's tab bar. `name` matches the start of the project's folder name
 * (before the timestamp), which a spec keeps unique so the project gets its
 * own standalone button.
 */
export async function openProjectFromSidebar(page: Page, name: RegExp): Promise<void> {
  const projectsSection = page.getByRole("button", { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0) {
    const expanded = await projectsSection.getAttribute("aria-expanded");
    if (expanded === "false") {
      await projectsSection.click();
      // The section is open when it SAYS so, not after half a second.
      await expect(projectsSection).toHaveAttribute("aria-expanded", "true");
    }
  }

  const btn = page
    .locator('[aria-label="Topics sidebar"] button')
    .filter({ hasText: name })
    .first();
  await expect(btn).toBeVisible({ timeout: 10000 });
  await btn.click();

  await expect(page.locator('[data-testid="panel-tab-bar"]').first()).toBeVisible({ timeout: 10000 });
}

/** The project window, the only place where "a tab of the project" exists:
 *  outside it there is the tab OF the project, which is another thing. */
export function projectWindow(page: Page): Locator {
  return page.locator('[data-testid="project-window"]:visible').first();
}

/**
 * Add a pane INSIDE the project window.
 *
 * The "+" is taken there and not with `getByTitle("Add pane").first()`: the
 * first one on the page belongs to the STANDALONE bar above the window, and
 * the pane it creates is born at app level, next to the project's tab instead
 * of inside it. A test that asks for "the project" and clicks that one
 * measures a surface it never opened — and stays green as long as the
 * standalone behaves as expected.
 */
export async function addPaneInProject(page: Page, itemTestId: string): Promise<void> {
  const trigger = projectWindow(page)
    .locator('[data-testid="pane-add-menu-trigger"]:visible')
    .first();
  await expect(trigger).toBeVisible({ timeout: 10000 });
  await trigger.click();
  const item = page.getByTestId(itemTestId).first();
  await expect(item).toBeVisible({ timeout: 5000 });
  await item.click();
}
