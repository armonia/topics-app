/**
 * General Auto, manual overrides and readable resolved task models.
 * Catalogs are fixtures; no login or model invocation is performed.
 * @covers MP-TASK-01 MP-TASK-03 MP-TASK-04 MP-TASK-05 MP-TASK-06 MP-TASK-07
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import type { ProvidersSnapshot } from '../../shared/types';
import { projectIdForPath } from '../../shared/board';
import { hermetic } from './fixtures/hermetic';
import { createTopic, deleteTask, deleteTopic, resetPaneStore, resetProjectPanes, seedProjectInnerPanes, seedProjectPane } from './helpers/api-fixtures';
import { canonicalTmpDir, removeTmpDir } from './helpers/file-project';

hermetic(test);
const projectPath = canonicalTmpDir('e2e-task-model-labels');
const projectId = projectIdForPath(projectPath);
const projectName = projectPath.split('/').pop()!;

async function mockModels(page: Page) {
  const fetchedAt = new Date().toISOString();
  const snapshot: ProvidersSnapshot = {
    generatedAt: new Date().toISOString(), defaultProvider: 'topics',
    providers: [
      { name: 'topics', label: 'Topics', status: 'ready', isDefault: true, models: ['claude-opus-4-8'], capabilities: ['coding-tasks'], requirements: [], fetchedAt },
      { name: 'codex', label: 'Codex', status: 'ready', isDefault: false, models: ['gpt-5.5'], capabilities: ['coding-tasks'], requirements: [], fetchedAt },
      { name: 'openai', label: 'OpenAI', status: 'ready', isDefault: false, models: ['gpt-api-only'], capabilities: ['streaming'], requirements: [], fetchedAt },
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

async function openProjectBoard(page: Page) {
  const row = page.getByTestId(`project-toggle-${projectName}`);
  if (!await row.isVisible()) await page.getByRole('button', { name: 'Toggle sidebar' }).click();
  await row.click();
  const projectWindow = page.locator(`[data-testid="project-window"][data-project-path="${projectPath}"]`);
  const opened = await projectWindow.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true).catch(() => false);
  if (!opened) {
    if (!await row.isVisible()) await page.getByRole('button', { name: 'Toggle sidebar' }).click();
    await row.click();
  }
  await expect(projectWindow).toBeVisible();
  const trigger = projectWindow.locator('[data-testid="pane-add-menu-trigger"]:visible').last();
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  const item = page.getByTestId('pane-add-menu-kanban');
  // The entry is MISSING, not slow, when the project already holds a kanban
  // pane: Board is a singleton and `availableTypesForGroup` drops the types
  // already open in the group. Waiting longer here never produced it, which is
  // why the caller clears the persisted layout instead.
  await item.waitFor({ state: 'visible', timeout: 5_000 });
  await item.click();
  await expect(projectWindow.getByTestId('kanban-board')).toBeVisible();
}

for (const device of [
  { name: 'desktop', locale: 'en', viewport: { width: 1280, height: 850 }, hasTouch: false },
  { name: 'phone', locale: 'it', viewport: { width: 390, height: 844 }, hasTouch: true },
]) {
  test.describe(`Task model · ${device.name}`, () => {
    test.use({ viewport: device.viewport, hasTouch: device.hasTouch });
    test('Auto spans coding providers, explicit models persist, assigned labels remain readable', async ({ page, request }, testInfo) => {
      mkdirSync(projectPath, { recursive: true });
      const topic = await createTopic(request, `Model labels ${device.name}`);
      const chatTopic = await createTopic(request, `Model chat ${device.name}`);
      const response = await request.post(`/api/boards/${projectId}/tasks`, { data: { text: `Model labels ${device.name}`, status: 'review' } });
      expect(response.ok()).toBe(true);
      const task = await response.json();
      const taskUrl = `/api/boards/${projectId}/tasks/${task.id}`;
      let longTaskId: string | undefined;
      try {
        await resetPaneStore(request, []);
        // `projectPath` is module-level, so the desktop run and the phone run
        // share ONE project, and the desktop run leaves its Board tab behind in
        // `topics-project-panes-<hash>` (projectLayoutSync persists the active
        // tab and union-adds it back on the next hydrate). The phone run then
        // opens a project window that already has a Board, and since Board is a
        // singleton `availableTypesForGroup` stops offering it: the add menu is
        // open and simply has no entry to click. The flake was only a race on
        // WHETHER the desktop page flushed before it closed, so seed the same
        // leftover here and make the state deterministic for both runs instead
        // of waiting for the retry to hand us a clean project.
        await seedProjectInnerPanes(request, projectPath, [
          { id: 'kanban:leftover-from-a-previous-run', type: 'kanban', title: 'Board' },
        ]);
        await resetProjectPanes(request, projectPath);
        await seedProjectPane(request, projectPath);
        await request.put('/api/ui-state/settings', { data: { language: device.locale } });
        await page.addInitScript((language) => localStorage.setItem('app-settings', JSON.stringify({ language })), device.locale);
        await mockModels(page);
        await page.goto(`/task/${task.id}`);
        const drawer = page.getByTestId('task-detail-drawer');
        const details = drawer.getByTestId('task-details-toggle');
        await details.click();
        const chip = drawer.getByTestId('task-model-chip');
        await expect(chip).toHaveAttribute('title', /tutti i provider|all providers/);
        await chip.click();
        await expect(page.getByRole('option', { name: /Auto \((project default|dal progetto)\)/ })).toBeVisible();
        // AICTRL-01: Topics is the routing switch above the list, never a
        // provider row. This line used to expect the row and went red on
        // 22/09 when the row was removed on purpose.
        await expect(page.getByRole('option', { name: /Topics/ })).toHaveCount(0);
        await expect(page.getByRole('option', { name: 'GPT-api-only', exact: true })).toHaveCount(0);
        const codexRuntime = page.locator('button[data-provider="codex"]');
        await codexRuntime.focus();
        await codexRuntime.press('Enter');
        const back = page.getByTestId('ai-selector-back');
        await expect(back).toBeFocused();
        await back.press('Enter');
        await expect(codexRuntime).toBeFocused();
        await codexRuntime.press('Enter');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        const codexModel = page.getByRole('option', { name: 'GPT-5.5', exact: true });
        await expect(codexModel).toBeFocused();
        await codexModel.press('Enter');
        await expect(chip).toHaveText(/GPT-5\.5.*Codex/);
        await expect.poll(async () => (await (await request.get(taskUrl)).json()).task.model).toBe('codex:gpt-5.5');
        await chip.click();
        await page.getByTestId('ai-selector-back').click();
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
        await expect(drawer).toBeHidden();

        const composer = page.locator('[data-testid="board-task-composer"]:visible');
        await composer.getByRole('textbox').click();
        const composerModel = composer.getByTestId('composer-model-chip');
        await expect(composerModel).toBeVisible();
        await composerModel.scrollIntoViewIfNeeded();
        await composerModel.click();
        await expect(page.locator('button[data-provider="topics"]')).toBeVisible();
        await expect(page.locator('button[data-provider="codex"]')).toBeVisible();
        await expect(page.locator('button[data-provider="openai"]')).toHaveCount(0);
        await page.keyboard.press('Escape');

        await openProjectBoard(page);
        const projectWindow = page.locator(`[data-testid="project-window"][data-project-path="${projectPath}"]`);
        const settingsButton = projectWindow.getByRole('button', { name: /Auto-dispatch settings|Impostazioni auto-dispatch/ });
        await expect(settingsButton).toBeVisible();
        await settingsButton.scrollIntoViewIfNeeded();
        await settingsButton.click();
        await expect(settingsButton).toHaveAttribute('aria-expanded', 'true');
        const projectModel = page.getByTestId('board-model-selector');
        await expect(projectModel).toBeVisible();
        await projectModel.scrollIntoViewIfNeeded();
        await projectModel.click();
        await expect(page.locator('button[data-provider="topics"]')).toBeVisible();
        await expect(page.locator('button[data-provider="codex"]')).toBeVisible();
        await expect(page.locator('button[data-provider="openai"]')).toHaveCount(0);
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('board-model-popover')).toBeHidden();
        if (device.hasTouch) {
          const settingsScrim = page.locator('div.fixed.inset-0.bg-black\\/40:visible').last();
          await settingsScrim.click({ position: { x: 8, y: 8 } });
        } else {
          await settingsButton.scrollIntoViewIfNeeded();
          await settingsButton.click();
        }
        await expect(settingsButton).toHaveAttribute('aria-expanded', 'false');
        await expect(page.getByTestId('board-settings-panel')).toBeHidden();

        const card = projectWindow.locator(`[data-task-card="${task.id}"]`);
        await expect(card.getByTestId('card-foot')).toContainText('GPT-5.5');
        const longModel = 'codex:project-model-with-a-long-release-identifier-2026';
        const longResponse = await request.post(`/api/boards/${projectId}/tasks`, {
          data: { text: `Long model ${device.name}`, status: 'review', model: longModel },
        });
        expect(longResponse.ok()).toBe(true);
        longTaskId = (await longResponse.json()).id;
        const longCard = projectWindow.locator(`[data-task-card="${longTaskId}"]`);
        const longChip = longCard.getByTestId('card-foot').getByText(`${longModel.slice(6)} · Codex`, { exact: true });
        await expect(longChip).toBeVisible();
        expect(await longChip.evaluate((element) => element.getBoundingClientRect().width
          <= element.parentElement!.getBoundingClientRect().width + 1)).toBe(true);
        await expect(longChip).toHaveAttribute('title', new RegExp(longModel.slice(6)));
        await page.screenshot({ path: testInfo.outputPath('resolved-card-model.png') });

        await page.goto(`/topic/${chatTopic.id}`);
        await expect(page.getByTestId('chat-message-input')).toBeVisible();
        const chatPicker = page.getByTestId('provider-model-picker').last();
        await expect(chatPicker).toBeVisible();
        await chatPicker.click();
        const chatPopover = page.getByTestId('provider-model-popover');
        await chatPopover.locator('button[data-provider="codex"]').click();
        await chatPopover.locator('button[data-model="gpt-5.5"]').click();
        await expect(chatPicker).toHaveAttribute('data-model', 'gpt-5.5');
        await chatPicker.click();
        await expect(chatPopover.locator('button[data-model="gpt-5.5"]')).toHaveAttribute('aria-selected', 'true');
        await page.keyboard.press('Escape');
      } finally {
        if (longTaskId) await deleteTask(request, projectId, longTaskId);
        await deleteTask(request, projectId, task.id);
        await deleteTopic(request, chatTopic.id);
        await deleteTopic(request, topic.id);
        removeTmpDir(projectPath);
      }
    });
  });
}
