/**
 * The task drawer opens on the conversation, with a compact head above it:
 * node and model chips, a «more» toggle, and, when the card carries a
 * delivery, a band with the outcome, the checks, the files and the decision
 * buttons. The band is always visible and sits outside the thread's scroll,
 * so a review can be decided without opening anything or scrolling.
 * @covers KANBAN-05
 */
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { hermetic } from './fixtures/hermetic';
import { createTopic, deleteTopic, deleteTask, resetPaneStore } from './helpers/api-fixtures';
import { canonicalTmpDir, removeTmpDir } from './helpers/file-project';
import { beat } from './helpers/evidence';
import { projectIdForPath } from '../../shared/board';

hermetic(test);

const projectPath = canonicalTmpDir('e2e-head-strip');
const projectId = projectIdForPath(projectPath);
const tasks: string[] = [];
const topics: string[] = [];

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok(), `${path}: ${response.status()}`).toBe(true);
  return response.json();
}

/**
 * A card with a long thread, bound to a topic, in the given status. A review
 * also gets a delivery through the real writer (the test door), so the band
 * and its decision buttons are the ones a person would see.
 */
async function seed(request: APIRequestContext, text: string, status: 'review' | 'in_progress') {
  const topic = await createTopic(request, text, { projectPath });
  topics.push(topic.id);
  const task = await post(request, `/api/boards/${projectId}/tasks`, { text, description: 'Explain which source supplies the chart.' });
  tasks.push(task.id);
  expect((await request.patch(`/api/boards/${projectId}/tasks/${task.id}`, { data: { status } })).ok()).toBe(true);
  await post(request, `/api/test/tasks/${task.id}/bind-topic`, { topicId: topic.id });
  const { message } = await post(request, `/api/test/topics/${topic.id}/session-row`, { role: 'assistant', content: 'Checked the source registry.' });
  for (let i = 1; i <= 30; i++) {
    await post(request, `/api/boards/${projectId}/tasks/${task.id}/comments`, { content: `Note ${i}: a line long enough to fill the thread.`, quiet: true });
  }
  await post(request, `/api/test/tasks/${task.id}/anchored-comment`, { content: 'The source is identified and the chart reads it.', author: 'agent', messageId: message.id });
  if (status === 'review') {
    await post(request, `/api/test/tasks/${task.id}/delivery`, { branch: 'task/head-strip', commit: 'delivered-commit', filesChanged: 3, insertions: 12, deletions: 2 });
  }
  return task.id as string;
}

/** Where the head sits and how tall it is: the thing that must not move while the thread scrolls. */
async function box(locator: Locator) {
  const b = await locator.boundingBox();
  expect(b, 'the element has a box').not.toBeNull();
  return b!;
}

async function openDrawer(page: Page, taskId: string) {
  await page.goto(`/task/${taskId}`);
  const drawer = page.getByTestId('task-detail-drawer');
  await expect(drawer.getByTestId('task-head-strip')).toBeVisible({ timeout: 20_000 });
  return drawer;
}

test.beforeAll(() => { mkdirSync(projectPath, { recursive: true }); });
test.beforeEach(async ({ request }) => { await resetPaneStore(request, []); });
test.afterAll(async ({ request }) => {
  for (const id of tasks) await deleteTask(request, projectId, id);
  for (const id of topics) await deleteTopic(request, id);
  removeTmpDir(projectPath);
});

// Top level on purpose: Playwright refuses `use({ video })` inside a describe group.
test.use({ video: 'on' });

test.describe('the head of the task drawer', () => {
  test('a review shows its delivery band and the decisions with no click, and the thread stays', async ({ page, request }) => {
    test.info().annotations.push({ type: 'spec', description: 'KANBAN-05' });
    await page.setViewportSize({ width: 1280, height: 800 });
    const taskId = await seed(request, 'Head strip with a delivery', 'review');
    const drawer = await openDrawer(page, taskId);

    const band = drawer.getByTestId('task-head-delivery');
    await expect(band).toBeVisible();
    await expect(band.getByTestId('task-head-files')).toBeVisible();
    for (const id of ['task-approve', 'task-send-back', 'task-land']) {
      await expect(band.getByTestId(id), `${id} is in the band with nothing opened`).toBeVisible();
      await expect(band.getByTestId(id)).toBeInViewport();
    }
    await expect(drawer.getByTestId('task-review-actions')).toBeVisible();
    // Nothing was opened: the panels are closed and the decisions are not inside them.
    await expect(drawer.getByTestId('task-delivery-panel')).toHaveCount(0);
    await expect(drawer.getByTestId('task-brief-scroll')).toHaveCount(0);
    await expect(drawer.getByTestId('task-head-node')).toBeVisible();
    await expect(drawer.getByTestId('task-head-model')).toBeVisible();

    // The thread is the default view and stays visible, with the head open too.
    const column = drawer.getByTestId('task-session-column');
    const scroller = column.getByTestId('task-conversation-scroll');
    await expect(scroller).toBeVisible();
    await drawer.getByTestId('task-details-toggle').click();
    await expect(drawer.getByTestId('task-brief-scroll')).toBeVisible();
    await expect(scroller).toBeVisible();
    await expect(drawer.getByTestId('task-composer')).toBeInViewport();
    expect((await box(scroller)).height, 'the thread keeps room to read with the details open').toBeGreaterThan(120);
    // The decisions did not move into the opened region and are still on screen.
    await expect(band.getByTestId('task-approve')).toBeInViewport();
    await expect(drawer.getByTestId('task-brief-scroll').getByTestId('task-approve')).toHaveCount(0);
    await drawer.getByTestId('task-details-toggle').click();
    await expect(drawer.getByTestId('task-brief-scroll')).toHaveCount(0);

    // The delivery panel opens above the thread and does not replace it.
    await drawer.getByTestId('task-delivery-toggle').click();
    await expect(drawer.getByTestId('task-delivery-panel')).toBeVisible();
    await expect(scroller).toBeVisible();
    await expect(band.getByTestId('task-approve')).toBeInViewport();
    await drawer.getByTestId('task-delivery-toggle').click();
    await expect(drawer.getByTestId('task-delivery-panel')).toHaveCount(0);
  });

  test('scrolling the thread leaves the head where it is', async ({ page, request }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const taskId = await seed(request, 'Head strip stays put', 'review');
    const drawer = await openDrawer(page, taskId);
    const strip = drawer.getByTestId('task-head-strip');
    const scroller = drawer.getByTestId('task-session-column').getByTestId('task-conversation-scroll');

    const metrics = await scroller.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
    expect(metrics.scrollHeight, 'the fixture thread is longer than its viewport').toBeGreaterThan(metrics.clientHeight);

    await scroller.evaluate((el) => el.scrollTo({ top: 0 }));
    const before = await box(strip);
    await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop), 'the thread really scrolled').toBeGreaterThan(0);
    const after = await box(strip);

    expect(Math.abs(after.y - before.y), 'the head did not move').toBeLessThan(1);
    expect(Math.abs(after.height - before.height), 'the head did not resize').toBeLessThan(1);
    await expect(strip.getByTestId('task-approve')).toBeInViewport();
    await expect(drawer.getByTestId('task-composer')).toBeInViewport();
  });

  test('on a phone the head, decisions included, stays under 45% of the screen', async ({ page, request }) => {
    const viewport = { width: 375, height: 812 };
    await page.setViewportSize(viewport);
    const taskId = await seed(request, 'Head strip on a phone', 'review');
    const drawer = await openDrawer(page, taskId);
    const strip = drawer.getByTestId('task-head-strip');

    await expect(strip.getByTestId('task-approve')).toBeInViewport();
    expect((await box(strip)).height, 'the head leaves most of the screen to the conversation').toBeLessThanOrEqual(viewport.height * 0.45);
    await expect(drawer.getByTestId('task-session-column').getByTestId('task-conversation-scroll')).toBeVisible();
    await expect(drawer.getByTestId('task-composer')).toBeInViewport();
    expect(await drawer.evaluate((el) => el.scrollWidth - el.clientWidth), 'no horizontal overflow').toBeLessThanOrEqual(1);
  });

  test('an open region above the thread never takes more than 45% of the screen', async ({ page, request }) => {
    const viewport = { width: 375, height: 812 };
    await page.setViewportSize(viewport);
    const taskId = await seed(request, 'Head strip region cap', 'review');
    const drawer = await openDrawer(page, taskId);

    await drawer.getByTestId('task-delivery-toggle').click();
    const panel = drawer.getByTestId('task-delivery-panel');
    await expect(panel).toBeVisible();
    expect((await box(panel.locator('xpath=..'))).height).toBeLessThanOrEqual(viewport.height * 0.45 + 1);
    await expect(drawer.getByTestId('task-head-strip').getByTestId('task-approve')).toBeInViewport();
  });
});

test.describe('the head of the task drawer, on video', () => {
  test('review with a delivery and a card at work, from a phone to an ultrawide screen', async ({ page, request }, testInfo) => {
    const review = await seed(request, 'Head strip video review', 'review');
    const working = await seed(request, 'Head strip video at work', 'in_progress');
    const widths = [375, 768, 1440, 3440];
    for (const [label, taskId] of [['review', review], ['working', working]] as const) {
      for (const width of widths) {
        // A reload per width: the drawer remounts when the layout crosses 768px.
        await page.setViewportSize({ width, height: 900 });
        const drawer = await openDrawer(page, taskId);
        await expect(drawer.getByTestId('task-session-column').getByTestId('task-conversation-scroll')).toBeVisible();
        if (label === 'review') await expect(drawer.getByTestId('task-head-delivery').getByTestId('task-approve')).toBeInViewport();
        await beat(page);
        const name = `head-strip-${label}-${width}`;
        await testInfo.attach(name, { body: await page.screenshot({ path: testInfo.outputPath(`${name}.png`) }), contentType: 'image/png' });
      }
    }
  });
});
