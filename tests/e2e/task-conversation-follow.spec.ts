/**
 * A reader following the last answer of a task's conversation stays on it while the drawer narrows and
 * widens (#275). WebKit is the engine that ships and the one that matters for the second net below, so
 * this spec runs in the `webkit` project too (playwright.config.ts).
 * @covers KANBAN-05
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { hermetic } from './fixtures/hermetic';
import { createTopic, deleteTopic, deleteTask, resetPaneStore } from './helpers/api-fixtures';
import { canonicalTmpDir, removeTmpDir } from './helpers/file-project';
import { mkdirSync } from 'node:fs';
import { projectIdForPath } from '../../shared/board';

hermetic(test);
const projectPath = canonicalTmpDir('e2e-conversation-follow');
const projectId = projectIdForPath(projectPath);
const tasks: string[] = [];
const topics: string[] = [];

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok(), `${path}: ${response.status()}`).toBe(true);
  return response.json();
}

async function seed(request: APIRequestContext, text: string) {
  const topic = await createTopic(request, text, { projectPath });
  topics.push(topic.id);
  const task = await post(request, `/api/boards/${projectId}/tasks`, { text });
  tasks.push(task.id);
  expect((await request.patch(`/api/boards/${projectId}/tasks/${task.id}`, { data: { status: 'review' } })).ok()).toBe(true);
  await post(request, `/api/test/tasks/${task.id}/bind-topic`, { topicId: topic.id });
  return { taskId: task.id as string, topicId: topic.id };
}

test.beforeAll(() => { mkdirSync(projectPath, { recursive: true }); });
test.beforeEach(async ({ request }) => { await resetPaneStore(request, []); });
test.afterAll(async ({ request }) => {
  for (const id of tasks) await deleteTask(request, projectId, id);
  for (const id of topics) await deleteTopic(request, id);
  removeTmpDir(projectPath);
});

test('a reader following the last answer keeps it in view while the drawer narrows and widens (#275)', async ({ page, request }, testInfo) => {
  // Two nets of TaskDetail's follow, each of which must turn this red when removed:
  //  (i) a ResizeObserver on the scroller and its content re-pins at every change of size: narrowing the
  //      drawer re-wraps the thread taller, and nothing else moves the reader back to the bottom;
  //  (ii) onScroll does not switch the follow off when the LAYOUT moved scrollTop: WebKit corrects it for the
  //      anchor before the observer re-pins, and the scroll event then reads "far from the bottom".
  // Measured on 09/10 (VM): without (i) the shorter-window step is red on Chromium and WebKit; without (ii)
  // the narrowing step is red on Chromium. Playwright's WebKit on Linux does not move scrollTop for the
  // anchor the way WKWebView on macOS does, so (ii) is not proven red there.
  await page.addInitScript(() => localStorage.setItem('board:taskDetailWide', '1'));
  await page.setViewportSize({ width: 1280, height: 800 });
  const { taskId, topicId } = await seed(request, 'Follow the answer while the drawer narrows');
  const { message } = await post(request, `/api/test/topics/${topicId}/session-row`, { role: 'assistant', content: 'Checked the source.' });
  const history = Array.from({ length: 40 }, (_, i) => `Earlier explanation ${i + 1}: the saved query supplies the chart and keeps the source selection available for review, with every filter the reader set before the last run.`).join('\n\n');
  await post(request, `/api/test/tasks/${taskId}/anchored-comment`, { content: history, author: 'agent', messageId: message.id });
  const answer = 'Latest answer: the source is ready for your next instruction.';
  await post(request, `/api/test/tasks/${taskId}/anchored-comment`, { content: answer, author: 'agent', messageId: message.id });
  await page.goto(`/task/${taskId}`);
  const drawer = page.getByTestId('task-detail-drawer');
  const scroller = drawer.getByTestId('task-conversation-scroll');
  const latest = scroller.getByText(answer, { exact: true });
  const overlay = drawer.getByTestId('task-thread-dropzone');
  const toggle = drawer.getByTestId('task-detail-wide-toggle');
  await expect(latest).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  const state = () => scroller.evaluate((el) => ({ remaining: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight), height: el.scrollHeight, width: el.clientWidth }));
  const answerInView = async () => {
    const [a, o, sc] = await Promise.all([latest.boundingBox(), overlay.boundingBox(), scroller.boundingBox()]);
    return !!a && !!o && !!sc && a.y >= sc.y - 1 && a.y + a.height <= o.y + 1;
  };
  await expect.poll(async () => (await state()).remaining, { message: 'following at rest' }).toBeLessThanOrEqual(2);
  const wide = await state();
  expect(wide.height - (await scroller.evaluate((el) => el.clientHeight)), 'fixture must overflow').toBeGreaterThan(0);

  for (let round = 1; round <= 2; round++) {
    // Narrowing: the same text wraps into more lines, the scroller grows by far more than the 80px grace.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => (await state()).width, { message: `round ${round}: the drawer narrowed` }).toBeLessThan(wide.width);
    await expect.poll(async () => (await state()).height - wide.height, { message: `round ${round}: the thread re-wrapped taller` }).toBeGreaterThan(160);
    await expect.poll(async () => (await state()).remaining, { message: `round ${round}: narrowed, the follow re-pins to the bottom` }).toBeLessThanOrEqual(2);
    await expect.poll(answerInView, { message: `round ${round}: narrowed, the last answer is in view` }).toBe(true);
    await testInfo.attach(`narrowed-${round}`, { body: await page.screenshot({ path: testInfo.outputPath(`narrowed-${round}.png`) }), contentType: 'image/png' });

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await state()).remaining, { message: `round ${round}: widened, still following` }).toBeLessThanOrEqual(2);
    await expect.poll(answerInView, { message: `round ${round}: widened, the last answer is in view` }).toBe(true);
  }

  // A window that gets shorter shrinks the scroller and nothing else: the composer keeps its size, so only
  // the observer on the scroller and the thread (i) can bring the reader back to the bottom.
  await page.setViewportSize({ width: 1280, height: 520 });
  await expect.poll(async () => (await state()).remaining, { message: 'shorter window: the follow re-pins to the bottom' }).toBeLessThanOrEqual(2);
  await expect.poll(answerInView, { message: 'shorter window: the last answer is in view' }).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(async () => (await state()).remaining, { message: 'taller window: still following' }).toBeLessThanOrEqual(2);
  await expect.poll(answerInView, { message: 'taller window: the last answer is in view' }).toBe(true);
});
