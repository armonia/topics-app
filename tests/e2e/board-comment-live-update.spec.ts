/** A saved comment remains visible despite slow or superseded detail reads.
 * @covers KANBAN-05 KANBAN-73
 */
import { test, expect } from '@playwright/test';
import { hermetic } from './fixtures/hermetic';
import { deleteTask, resetPaneStore } from './helpers/api-fixtures';

hermetic(test);
const projectId = 'comment-live-fixture';
const tasks: string[] = [];
test.beforeEach(async ({ request }) => { await resetPaneStore(request, []); });
test.afterAll(async ({ request }) => {
  for (const taskId of tasks) await deleteTask(request, projectId, taskId);
});

test('a POST acknowledgement appears immediately and an earlier GET cannot erase it', async ({ page, request }, testInfo) => {
  const created = await request.post(`/api/boards/${projectId}/tasks`, { data: { text: 'Review a source editor', status: 'review' } });
  expect(created.ok()).toBe(true);
  const task = await created.json();
  tasks.push(task.id);
  const detailPath = `/api/boards/${projectId}/tasks/${task.id}`;
  for (let index = 0; index < 12; index++) {
    const response = await request.post(`${detailPath}/comments`, {
      data: { content: `Earlier discussion ${index + 1}. ${'The source editor needs a clear relationship between the table and the chart. '.repeat(8)}`, quiet: true },
    });
    expect(response.ok()).toBe(true);
  }
  await page.goto(`/task/${task.id}`);
  const drawer = page.getByTestId('task-detail-drawer');
  const conversation = drawer.getByTestId('task-session-column');
  await expect(drawer.getByText('Review a source editor', { exact: true }).first()).toBeVisible();
  await drawer.getByTestId('task-conversation-scroll').evaluate((element) => { element.scrollTop = 0; });

  const before = await (await request.get(detailPath)).json();
  let releaseOld!: () => void;
  let releaseFresh!: () => void;
  let oldStarted!: () => void;
  const oldPending = new Promise<void>((resolve) => { releaseOld = resolve; });
  const freshPending = new Promise<void>((resolve) => { releaseFresh = resolve; });
  const started = new Promise<void>((resolve) => { oldStarted = resolve; });
  let reads = 0;
  await page.route(`**${detailPath}`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    if (++reads === 1) {
      oldStarted();
      await oldPending;
      await route.fulfill({ json: before, headers: { 'x-test-stale-read': '1' } });
    } else {
      await freshPending;
      await route.continue();
    }
  });
  // A wake-up read started before the person sends their reply.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await started;
  try {
    const reply = 'Is this the clearest way to manage the source?';
    await drawer.getByTestId('task-reply-input').fill(reply);
    const accepted = page.waitForResponse((response) => response.url().endsWith(`${detailPath}/comments`) && response.request().method() === 'POST');
    await drawer.getByTestId('task-composer-submit').click();
    expect((await accepted).ok()).toBe(true);
    // All detail reads remain held: only the acknowledged POST can paint this.
    await expect(conversation.getByText(reply, { exact: true })).toBeVisible();
    await expect(drawer.getByTestId('task-reply-input')).toHaveValue('');
    await expect(drawer.getByTestId('task-comment-receipt')).toContainText(/nota|note/i);
    releaseFresh();
    await expect.poll(() => reads).toBeGreaterThan(1);
    const oldReturned = page.waitForResponse((response) => response.headers()['x-test-stale-read'] === '1');
    releaseOld();
    await (await oldReturned).finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(conversation.getByText(reply, { exact: true })).toHaveCount(1);
    await expect(conversation.getByText(reply, { exact: true })).toBeVisible();
    const saved = await (await request.get(detailPath)).json();
    expect(saved.task.status).toBe('review');
    expect(saved.task.assignedTopicId).toBeNull();
    expect(saved.comments.filter((comment: { content: string }) => comment.content === reply)).toHaveLength(1);
    await expect(drawer.getByTestId('task-comment-note-context')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('saved-comment-stays-visible.png') });
  } finally {
    releaseFresh();
    releaseOld();
  }
});

test('a failed revalidation keeps the saved reply and offers retry without resending', async ({ page, request }, testInfo) => {
  const created = await request.post(`/api/boards/${projectId}/tasks`, { data: { text: 'Saved reply with a failed refresh', status: 'review' } });
  expect(created.ok()).toBe(true);
  const task = await created.json();
  tasks.push(task.id);
  const detailPath = `/api/boards/${projectId}/tasks/${task.id}`;
  await page.goto(`/task/${task.id}`);
  const drawer = page.getByTestId('task-detail-drawer');
  const conversation = drawer.getByTestId('task-session-column');
  await expect(drawer.getByText('Saved reply with a failed refresh', { exact: true }).first()).toBeVisible();
  await page.route(`**${detailPath}`, async (route) => {
    if (route.request().method() === 'GET') await route.fulfill({ status: 503, json: { error: 'Temporary detail outage' } });
    else await route.continue();
  });
  const reply = 'Keep this confirmed comment during the outage';
  await drawer.getByTestId('task-reply-input').fill(reply);
  await drawer.getByTestId('task-composer-submit').click();
  await expect(conversation.getByText(reply, { exact: true })).toBeVisible();
  await expect(drawer.getByTestId('task-reply-input')).toHaveValue('');
  await expect(drawer.getByTestId('task-stale-warning')).toBeVisible();
  await page.unroute(`**${detailPath}`);
  await drawer.getByTestId('task-stale-retry').click();
  await expect(drawer.getByTestId('task-stale-warning')).toHaveCount(0);
  await expect(conversation.getByText(reply, { exact: true })).toHaveCount(1);
  const saved = await (await request.get(detailPath)).json();
  expect(saved.comments.filter((comment: { content: string }) => comment.content === reply)).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath('saved-comment-after-retry.png') });
});

test('another client updates the open conversation through the task broadcast', async ({ page, request }, testInfo) => {
  const created = await request.post(`/api/boards/${projectId}/tasks`, { data: { text: 'Shared task conversation', status: 'review' } });
  expect(created.ok()).toBe(true);
  const task = await created.json();
  tasks.push(task.id);
  await page.goto(`/task/${task.id}`);
  const drawer = page.getByTestId('task-detail-drawer');
  await expect(drawer.getByText('Shared task conversation', { exact: true }).first()).toBeVisible();
  const reply = 'Comment from the other collaborator';
  const response = await request.post(`/api/boards/${projectId}/tasks/${task.id}/comments`, { data: { content: reply, quiet: true } });
  expect(response.ok()).toBe(true);
  await expect(drawer.getByText(reply, { exact: true })).toBeVisible();
  await expect(drawer.getByText(reply, { exact: true })).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('remote-comment-live.png') });
});
