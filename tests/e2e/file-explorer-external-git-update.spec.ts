import { expect } from "@playwright/test";
import { writeFileSync } from "fs";
import { join } from "path";
import { test } from "./fixtures/file-explorer.fixture";
import { cleanupFileProject, seedFileProject, type FileProject } from "./helpers/file-project";
import { hermetic } from "./fixtures/hermetic";

hermetic(test);
test.use({ video: "on" });

test("un file salvato fuori da Topics aggiorna Git entro un secondo", async ({ fileExplorerPage, page }) => {
  test.info().annotations.push({ type: "spec", description: "FILE-02" });
  let project: FileProject | undefined;
  try {
    project = await seedFileProject(page.request, "d1a-external-git");
    await fileExplorerPage.gotoProject(project.tmpDir, project.topicName);

    const gitChanges = page.locator('[data-testid="git-changes"]');
    await expect(gitChanges).toBeVisible({ timeout: 10_000 });
    const gitHeader = gitChanges.locator("div").filter({ hasText: /^Git$/ }).first();
    const existingStatus = gitChanges.locator("span", { hasText: /^[MDUA]$/ });
    if (!(await existingStatus.first().isVisible().catch(() => false))) await gitHeader.click();
    const newPath = join(project.tmpDir, "saved-outside-topics.txt");
    const startedAt = Date.now();
    writeFileSync(newPath, "written by an external editor\n");

    await expect(gitChanges.locator('[data-git-file="saved-outside-topics.txt"]'))
      .toBeVisible({ timeout: 1_000 });
    expect(Date.now() - startedAt, "the watcher push must beat the status poll").toBeLessThanOrEqual(1_000);
  } finally {
    await cleanupFileProject(page.request, project);
  }
});
