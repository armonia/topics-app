/**
 * General Auto, manual overrides and readable resolved task models.
 * Catalogs are fixtures; no login or model invocation is performed.
 * @covers MP-TASK-01 MP-TASK-03
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import type { ProvidersSnapshot } from '../../shared/types';
import { projectIdForPath } from '../../shared/board';
import { hermetic } from './fixtures/hermetic';
import { createTopic, deleteTask, deleteTopic, resetPaneStore } from './helpers/api-fixtures';
import { canonicalTmpDir, removeTmpDir } from './helpers/file-project';

hermetic(test);
const projectPath = canonicalTmpDir('e2e-task-model-labels');
const projectId = projectIdForPath(projectPath);

async function mockCatalog(page: Page) {
  const fetchedAt = new Date().toISOString();
  const snapshot: ProvidersSnapshot = {
    generatedAt: new Date().toISOString(), defaultProvider: 'topics',
    providers: [
      { name: 'topics', status: 'ready', isDefault: true, models: ['claude-opus-4-8'], requirements: [], fetchedAt },
      { name: 'codex', status: 'ready', isDefault: false, models: ['gpt-5.5'], requirements: [], fetchedAt },
      { name: 'openai', status: 'ready', isDefault: false, models: ['gpt-api-only'], requirements: [], fetchedAt },
    ],
  };
  await page.route('**/api/providers/snapshot', (route) => route.fulfill({ json: snapshot }));
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => socket.send(typeof message === 'string' && message.includes('"providers:snapshot"')
      ? JSON.stringify({ type: 'providers:snapshot', snapshot }) : message));
    socket.onMessage((message) => server.send(message));
  });
}

for (const device of [
  { name: 'desktop', locale: 'en', viewport: { width: 1280, height: 850 }, hasTouch: false },
  { name: 'phone', locale: 'it', viewport: { width: 390, height: 844 }, hasTouch: true },
]) {
  test.describe(`Task model · ${device.name}`, () => {
    test.use({ viewport: device.viewport, hasTouch: device.hasTouch });
    test('Auto spans coding providers, explicit models persist, assigned labels remain readable', async ({ page, request }, testInfo) => {
      mkdirSync(projectPath, { recursive: true });
      const topic = await createTopic(request, `Model labels ${device.name}`, { projectPath });
      const response = await request.post(`/api/boards/${projectId}/tasks`, { data: { text: `Model labels ${device.name}`, status: 'review' } });
      expect(response.ok()).toBe(true);
      const task = await response.json();
      const taskUrl = `/api/boards/${projectId}/tasks/${task.id}`;
      let longTaskId: string | undefined;
      try {
        await resetPaneStore(request, []);
        await request.put('/api/ui-state/settings', { data: { language: device.locale } });
        await page.addInitScript((language) => localStorage.setItem('app-settings', JSON.stringify({ language })), device.locale);
        await mockCatalog(page);
        await page.goto(`/task/${task.id}`);
        const drawer = page.getByTestId('task-detail-drawer');
        const details = drawer.getByTestId('task-details-toggle');
        await details.click();
        const chip = drawer.getByTestId('task-model-chip');
        await expect(chip).toHaveAttribute('title', /tutti i provider|all providers/);
        await chip.click();
        await expect(page.getByRole('option', { name: /Auto \((project default|dal progetto)\)/ })).toBeVisible();
        await expect(page.getByRole('option', { name: 'Opus 4.8', exact: true })).toBeVisible();
        await expect(page.getByRole('option', { name: 'GPT-api-only', exact: true })).toHaveCount(0);
        await page.getByRole('option', { name: 'GPT-5.5', exact: true }).click();
        await expect(chip).toHaveText('GPT-5.5');
        await expect.poll(async () => (await (await request.get(taskUrl)).json()).task.model).toBe('gpt-5.5');
        await chip.click();
        await page.getByRole('option', { name: /Auto \((project default|dal progetto)\)/ }).click();
        await expect.poll(async () => (await (await request.get(taskUrl)).json()).task.model).toBeNull();

        // The dispatcher persists the chosen model before assignment. Seed the
        // same state through the test binding endpoint without running an agent.
        expect((await request.patch(taskUrl, { data: { model: 'gpt-5.5' } })).ok()).toBe(true);
        expect((await request.post(`/api/test/tasks/${task.id}/bind-topic`, { data: { topicId: topic.id } })).ok()).toBe(true);
        await page.reload();
        await details.click();
        await expect(chip).toHaveText('GPT-5.5');
        await expect(chip).toHaveAttribute('aria-disabled', 'true');
        await expect(chip).toHaveAttribute('title', /GPT-5\.5/);
        await chip.click({ force: true });
        await expect(page.getByRole('option', { name: 'GPT-5.5', exact: true })).toHaveCount(0);
        const metrics = await chip.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const parent = element.parentElement!.getBoundingClientRect();
          return { left: box.left, right: box.right, parentLeft: parent.left, parentRight: parent.right };
        });
        expect(metrics.left).toBeGreaterThanOrEqual(metrics.parentLeft - 1);
        expect(metrics.right).toBeLessThanOrEqual(metrics.parentRight + 1);
        await page.screenshot({ path: testInfo.outputPath('resolved-task-model.png') });
        await drawer.getByRole('button', { name: /Close the task detail|Chiudi il dettaglio del task/ }).click();
        const card = page.locator(`[data-task-card="${task.id}"]`);
        await expect(card.getByTestId('card-foot')).toContainText('GPT-5.5');
        const longModel = 'codex:project-model-with-a-long-release-identifier-2026';
        const longResponse = await request.post(`/api/boards/${projectId}/tasks`, {
          data: { text: `Long model ${device.name}`, status: 'review', model: longModel },
        });
        expect(longResponse.ok()).toBe(true);
        longTaskId = (await longResponse.json()).id;
        const longCard = page.locator(`[data-task-card="${longTaskId}"]`);
        const longChip = longCard.getByTestId('card-foot').getByText(`${longModel.slice(6)} · Codex`, { exact: true });
        await expect(longChip).toBeVisible();
        expect(await longChip.evaluate((element) => element.getBoundingClientRect().width
          <= element.parentElement!.getBoundingClientRect().width + 1)).toBe(true);
        await expect(longChip).toHaveAttribute('title', new RegExp(longModel.slice(6)));
        await page.screenshot({ path: testInfo.outputPath('resolved-card-model.png') });
      } finally {
        if (longTaskId) await deleteTask(request, projectId, longTaskId);
        await deleteTask(request, projectId, task.id);
        await deleteTopic(request, topic.id);
        removeTmpDir(projectPath);
      }
    });
  });
}
