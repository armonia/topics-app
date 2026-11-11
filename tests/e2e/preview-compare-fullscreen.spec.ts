/**
 * FULL-SCREEN EVIDENCE with a before/after divider (card c7afcd0b).
 * A delivery with a before file and an after file opens, from the board card,
 * a dark viewer with one frame and a divider; Esc closes it. The drawer shows
 * the proof open at the top of the conversation, no click needed.
 */
import { test } from './fixtures/layout.fixture';
import { expect, type Page } from '@playwright/test';
import { projectRow } from './helpers/project-row';
import { E2E_BASE, E2E_PORT, testServerEnv } from './helpers/test-server';
import { hermetic } from './fixtures/hermetic';
import { projectIdForPath } from '../../shared/board';
import { createTopic, deleteTopic } from './helpers/api-fixtures';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { canonicalTmpRoot, removeTmpDir } from "./helpers/file-project";

hermetic(test);

const PROJECT_PATH = `${canonicalTmpRoot()}/e2e-compare-${Date.now()}`;
const PROJECT_ID = projectIdForPath(PROJECT_PATH);
const MEDIA_DIR = `${testServerEnv(E2E_PORT).TOPICS_HOME}/media/e2e-compare-${Date.now()}`;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAAFElEQVR4nGP8//8/AzJgYkAD5AsAAP//B5wBiOtZQOgAAAAASUVORK5CYII=',
  'base64',
);

let topicId: string | null = null;
let taskId = '';

test.beforeAll(async ({ request }) => {
  mkdirSync(MEDIA_DIR, { recursive: true });
  mkdirSync(PROJECT_PATH, { recursive: true });
  writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: 'e2e-compare' }));
  for (const n of ['board-prima', 'board-dopo']) writeFileSync(`${MEDIA_DIR}/${n}.png`, PNG);
  const t = await createTopic(request, 'E2E-Compare', { projectPath: PROJECT_PATH });
  topicId = t.id;
  const res = await request.post(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks`, {
    data: { text: 'card con prima e dopo', status: 'review' },
  });
  taskId = ((await res.json()) as { id: string }).id;
  const rp = await request.patch(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks/${taskId}`, {
    data: { previewImage: `${MEDIA_DIR}/board-prima.png` },
  });
  expect(rp.ok(), `cover rejected: ${rp.status()}`).toBe(true);
  const rc = await request.post(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks/${taskId}/comments`, {
    data: { content: 'dopo', media: [`${MEDIA_DIR}/board-dopo.png`] },
  });
  expect(rc.ok(), `attachment rejected: ${rc.status()}`).toBe(true);
});

test.afterAll(async ({ request }) => {
  if (topicId) await deleteTopic(request, topicId).catch(() => undefined);
  removeTmpDir(PROJECT_PATH);
  removeTmpDir(MEDIA_DIR);
});

async function openBoard(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });
  const projectsSection = page.getByRole('button', { name: /sezione Progetti/ });
  if ((await projectsSection.count()) > 0 && (await projectsSection.getAttribute('aria-expanded')) === 'false') await projectsSection.click();
  const projectEntry = projectRow(page, /e2e-compare/);
  await expect(projectEntry).toBeVisible({ timeout: 20_000 });
  await projectEntry.click();
  await expect(page.getByTestId('project-window')).toBeVisible({ timeout: 20_000 });

  const triggers = page.getByTestId('pane-add-menu-trigger');
  const kanbanEntry = page.getByTestId('pane-add-menu-kanban');
  for (let i = (await triggers.count()) - 1; i >= 0; i--) {
    const t = triggers.nth(i);
    if (!(await t.isVisible().catch(() => false))) continue;
    if (!(await t.click({ timeout: 3000 }).then(() => true, () => false))) continue;
    if (await kanbanEntry.waitFor({ state: 'visible', timeout: 2000 }).then(() => true, () => false)) {
      await kanbanEntry.click();
      return;
    }
    await page.keyboard.press('Escape');
  }
  if (await page.locator('[data-testid^="kanban-column-"]').first().isVisible().catch(() => false)) return;
  throw new Error('non si e\' trovata la board');
}

test.describe('full-screen before/after evidence', () => {
  test('opens from the card, moves the divider, closes with Esc', async ({ page }) => {
    await openBoard(page);
    const img = page.locator('[data-testid="preview-card"] img').first();
    await expect(img).toBeVisible({ timeout: 20_000 });
    await img.click();
    await expect(page.getByTestId('preview-lightbox')).toBeVisible({ timeout: 5_000 });
    const frame = page.getByTestId('evidence-compare');
    await expect(frame).toBeVisible();
    await expect(page.getByTestId('evidence-label-before')).toBeVisible();
    await expect(page.getByTestId('evidence-label-after')).toBeVisible();
    // Drag the divider to the left quarter of the frame.
    const box = (await frame.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => Number(await page.getByTestId('evidence-slider').inputValue())).toBeLessThan(35);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('preview-lightbox')).toHaveCount(0);
  });

  test('the drawer shows the proof open at the top of the conversation', async ({ page }) => {
    await openBoard(page);
    await page.getByTestId('kanban-board').getByText('card con prima e dopo').first().click();
    const evidence = page.getByTestId('delivery-evidence');
    await expect(evidence).toBeVisible({ timeout: 15_000 });
    await evidence.getByTestId('delivery-evidence-item').first().click();
    await expect(page.getByTestId('evidence-compare')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('preview-lightbox')).toHaveCount(0);
  });
});
