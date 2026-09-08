/**
 * Mixed provider turns must not bury a task's conversation under tool traces.
 * The real failure combined native Topics tool names with prose and dozens of
 * tools in a single assistant message, followed by anchored board comments.
 * @covers KANBAN-73
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { hermetic } from './fixtures/hermetic';
import { createTopic, deleteTopic, deleteTask, resetPaneStore } from './helpers/api-fixtures';
import { canonicalTmpDir, removeTmpDir } from './helpers/file-project';
import { projectIdForPath } from '../../shared/board';
import { testServerEnv } from './helpers/test-server';

hermetic(test);
const projectPath = canonicalTmpDir('e2e-conversation-details');
const projectId = projectIdForPath(projectPath);
const imagePath = `${projectPath}/session-result.svg`;
const previewPath = `${testServerEnv().TOPICS_HOME}/media/e2e-conversation-focus-${Date.now()}.svg`;
const tasks: string[] = [];
const topics: string[] = [];

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok(), `${path}: ${response.status()}`).toBe(true);
  return response.json();
}

async function seed(request: APIRequestContext, text: string, extra: { description?: string; previewImage?: string } = {}) {
  const topic = await createTopic(request, text, { projectPath });
  topics.push(topic.id);
  const task = await post(request, `/api/boards/${projectId}/tasks`, { text, description: extra.description });
  tasks.push(task.id);
  expect((await request.patch(`/api/boards/${projectId}/tasks/${task.id}`, { data: { status: 'review', previewImage: extra.previewImage } })).ok()).toBe(true);
  if (extra.previewImage) {
    const response = await request.get(`/api/boards/${projectId}/tasks/${task.id}`);
    expect(response.ok()).toBe(true);
    expect((await response.json()).task.previewImage, 'the preview fixture must survive the path allowlist').toBe(extra.previewImage);
  }
  await post(request, `/api/test/tasks/${task.id}/bind-topic`, { topicId: topic.id });
  return { taskId: task.id as string, topicId: topic.id };
}

test.beforeAll(() => {
  mkdirSync(projectPath, { recursive: true });
  mkdirSync(`${testServerEnv().TOPICS_HOME}/media`, { recursive: true });
  const image = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><rect width="240" height="80" fill="#e0ede9"/><text x="20" y="44" fill="#164e3d">Source → Chart</text></svg>';
  writeFileSync(imagePath, image);
  writeFileSync(previewPath, image);
});
test.beforeEach(async ({ request }) => { await resetPaneStore(request, []); });
test.afterAll(async ({ request }) => {
  for (const id of tasks) await deleteTask(request, projectId, id);
  for (const id of topics) await deleteTopic(request, id);
  removeTmpDir(projectPath);
  unlinkSync(previewPath);
});

test('a task opens on one conversation; repeated preview and long brief never steal its space', async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const title = 'Understand the source before deciding the next step, with the complete task context available even when the title needs several lines in a narrow preview';
  const description = Array.from({ length: 24 }, (_, i) => `Requirement ${i + 1}: preserve the context and explain how the source supplies the chart.`).join('\n\n');
  const answer = 'The diagram shows the source used by the chart. Choose the source to continue.';
  const technical = 'Inspected the source registry and checked the chart query.';
  const { taskId, topicId } = await seed(request, title, { description, previewImage: previewPath });
  const { message } = await post(request, `/api/test/topics/${topicId}/session-row`, {
    role: 'assistant', content: `${technical}\nMEDIA:${previewPath}`,
    blocks: [
      { kind: 'text', text: technical },
      { kind: 'tool', toolCall: { id: 'focus-inspection', name: 'Read', args: { file_path: 'sources.ts' }, status: 'success' } },
      { kind: 'tool', toolCall: { id: 'focus-comment', name: 'comment_task', args: { content: answer }, status: 'success' } },
    ],
  });
  await post(request, `/api/test/tasks/${taskId}/anchored-comment`, { content: answer, author: 'agent', messageId: message.id });
  const delivery = 'The source needs a contract key.\n\nThe explanation and source diagram have been delivered.';
  const { comment: deliveryComment } = await post(request, `/api/test/tasks/${taskId}/anchored-comment`, {
    content: delivery, author: 'agent', messageId: message.id,
  });
  // The fixture endpoint writes ordinary comments. Exercise the persisted
  // delivery shape without adding a production mutation for this UI test.
  await page.route(`**/api/boards/${projectId}/tasks/${taskId}`, async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.comments = data.comments.map((comment: { id: string; kind: string }) => comment.id === deliveryComment.id ? { ...comment, kind: 'delivery' } : comment);
    await route.fulfill({ response, json: data });
  });
  await page.goto(`/task/${taskId}`);

  const drawer = page.getByTestId('task-detail-drawer');
  const conversation = drawer.getByTestId('task-session-column');
  const row = conversation.locator(`[data-testid="task-session-item"][data-message-id="${message.id}"]`);
  const workspace = drawer.getByTestId('task-workspace-toggle');
  const details = drawer.getByTestId('task-details-toggle');
  const header = drawer.getByTestId('task-brief-header');
  await expect(header.getByText(title, { exact: true })).toBeVisible();
  await expect(conversation.getByText(answer, { exact: true })).toBeVisible();
  const deliveryNote = conversation.getByTestId('task-delivery-note');
  await expect(deliveryNote).toBeVisible();
  await expect(deliveryNote.getByTestId('task-delivery-note-preview')).toBeVisible();
  await expect(deliveryNote.getByTestId('task-delivery-note-preview')).toContainText('The source needs a contract key.');
  await expect(deliveryNote.getByTestId('task-delivery-note-body')).toBeHidden();
  await deliveryNote.locator('summary').press('Enter');
  await expect(deliveryNote.getByTestId('task-delivery-note-body')).toBeVisible();
  await expect(deliveryNote.getByTestId('task-delivery-note-body')).toContainText('The explanation and source diagram have been delivered.');
  await deliveryNote.locator('summary').click();
  await expect(workspace).toHaveAttribute('data-open', '0');
  await expect(drawer.getByTestId('task-drawer-body')).toHaveCount(0);
  await expect(drawer.getByTestId('task-brief-scroll')).toHaveCount(0);
  await expect(row.getByTestId('task-work-summary')).toBeVisible();
  await expect(row.getByTestId('task-work-body')).toHaveCount(0);
  await expect(drawer.getByTestId('media-image')).toHaveCount(1);
  await expect(row.getByTestId('media-image')).toBeVisible();
  await expect(drawer.getByTestId('task-detail-preview').locator('img')).toHaveCount(0);
  const drawerBox = (await drawer.boundingBox())!;
  const conversationBox = (await conversation.boundingBox())!;
  expect(conversationBox.height, 'conversation owns most of the task, even with a long description').toBeGreaterThan(drawerBox.height * 0.5);
  await testInfo.attach('conversation-focus', { body: await page.screenshot({ path: testInfo.outputPath('conversation-focus.png') }), contentType: 'image/png' });

  // The shared attachment is opened where the reply explains it. Closing the
  // viewer keeps the same row and its folded session detail in the timeline.
  await row.getByTestId('media-image').click();
  await expect(page.getByTestId('image-lightbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('image-lightbox')).toHaveCount(0);
  await expect(row.getByTestId('task-work-summary')).toBeVisible();

  await details.click();
  const brief = conversation.getByTestId('task-brief-scroll');
  await expect(brief).toBeVisible();
  expect(await brief.evaluate((el) => getComputedStyle(el).overflowY)).not.toMatch(/auto|scroll/);
  await details.click();
  await expect(brief).toHaveCount(0);

  // On a narrow task, the explicit workspace view replaces the reading area.
  // Returning must not reset the thread or duplicate its content.
  await workspace.click();
  await expect(workspace).toHaveAttribute('data-open', '1');
  await expect(drawer.getByTestId('task-drawer-body')).toBeVisible();
  await expect(conversation).toBeHidden();
  await drawer.getByTestId('task-conversation-toggle').click();
  await expect(drawer.getByTestId('task-drawer-body')).toHaveCount(0);
  await expect(conversation.getByText(answer, { exact: true })).toBeVisible();
  await expect(row.getByTestId('media-image')).toHaveCount(1);
  await row.getByTestId('task-work-summary').click();
  await expect(row.getByText(technical, { exact: true })).toBeVisible();
  // Opening details from a hidden reading area must scroll after it is visible.
  await workspace.click();
  await details.click();
  await expect(conversation.getByTestId('task-brief-scroll')).toBeInViewport();
  await expect.poll(() => conversation.getByTestId('task-conversation-scroll').evaluate((el) => el.scrollTop)).toBe(0);
  await details.click();
  await page.setViewportSize({ width: 1280, height: 600 });
  await expect(header.getByText(title, { exact: true })).toBeInViewport();
  await expect(drawer.locator('textarea').last()).toBeInViewport();
  expect((await conversation.boundingBox())!.height).toBeGreaterThan(120);
});

test('conversation stays readable; session detail mounts only when expanded and preserves the transcript', async ({ page, request }, testInfo) => {
  const { taskId, topicId } = await seed(request, 'Conversation and session detail');
  const answer = 'The source can be added from the administration screen.';
  const technical = 'Checked the schema and the source registry.';
  const final = 'Session conclusion with supporting context.';
  const calls = Array.from({ length: 36 }, (_, i) => ({
    kind: 'tool', toolCall: { id: `inspection-${i}`, name: 'bash', args: { command: `inspect source ${i}` }, status: 'success' },
  }));
  const { message } = await post(request, `/api/test/topics/${topicId}/session-row`, {
    // Real completed turns can receive media only in content, after blocks
    // have already been persisted. It stays visible outside the work fold.
    role: 'assistant', content: `${technical}\n${final}\nMEDIA:${imagePath}`,
    blocks: [
      { kind: 'text', text: technical }, ...calls,
      { kind: 'tool', toolCall: { id: 'mirrored-comment', name: 'comment_task', args: { content: answer }, status: 'success' } },
      { kind: 'text', text: final },
    ],
  });
  await post(request, `/api/test/tasks/${taskId}/anchored-comment`, { content: answer, author: 'agent', messageId: message.id });
  await page.goto(`/task/${taskId}`);
  const drawer = page.getByTestId('task-detail-drawer');
  await expect(drawer).toBeVisible();
  const row = drawer.locator(`[data-testid="task-session-item"][data-message-id="${message.id}"]`);
  await expect(row).toBeVisible();
  const measure = () => drawer.evaluate((el) => ({ nodes: el.querySelectorAll('*').length, height: el.scrollHeight }));
  await testInfo.attach('conversation-initial', { body: await page.screenshot({ path: testInfo.outputPath('conversation-closed.png') }), contentType: 'image/png' });
  const closed = await measure();
  await expect(drawer.getByText(answer, { exact: true })).toBeVisible();
  await expect(row.getByTestId('task-work-summary')).toContainText(/Dettagli sessione|Session details/);
  await expect(row.getByTestId('task-work-body')).toHaveCount(0);
  await expect(row.getByTestId('media-image')).toBeVisible();
  await expect(row.getByTestId('media-image')).toHaveCount(1);
  await expect(row.getByText(technical, { exact: true })).toHaveCount(0);
  await row.getByTestId('task-work-summary').focus();
  await page.keyboard.press('Enter');
  await expect(row.getByTestId('task-work-body')).toBeVisible();
  await expect(row.getByText(technical, { exact: true })).toBeVisible();
  await expect(row.getByText(final, { exact: true })).toBeVisible();
  await expect(row.getByTestId('tool-call-row-mirrored-comment')).toHaveCount(0);
  await expect(row.getByTestId('media-image')).toHaveCount(1);
  const expanded = await measure();
  expect(expanded.nodes).toBeGreaterThan(closed.nodes);
  await testInfo.attach('session-expanded', { body: await page.screenshot({ path: testInfo.outputPath('session-expanded.png') }), contentType: 'image/png' });
  await row.getByTestId('task-work-summary').click();
  await expect(row.getByTestId('task-work-body')).toHaveCount(0);
  console.log(`CONVERSATION_DOM ${JSON.stringify({ closed, expanded })}`);
});

test('unmirrored prose stays visible while completed tools fold; a waiting question remains answerable', async ({ page, request }) => {
  const { taskId, topicId } = await seed(request, 'Keep answers and pending questions visible');
  const { message } = await post(request, `/api/test/topics/${topicId}/session-row`, {
    role: 'assistant', content: 'I checked the input. The result is ready.',
    blocks: [
      { kind: 'text', text: 'I checked the input.' },
      { kind: 'tool', toolCall: { id: 'completed-read', name: 'Read', args: { file_path: 'source.ts' }, status: 'success' } },
      { kind: 'text', text: 'The result is ready.' },
    ],
  });
  const { message: waiting } = await post(request, `/api/test/topics/${topicId}/session-row`, {
    role: 'assistant', content: '',
    blocks: [{ kind: 'tool', toolCall: {
      id: 'pending-choice', name: 'mcp__topics__ask_user_question', args: {}, status: 'waiting_for_input',
      userInputSchema: { kind: 'questions', questions: [{ question: 'Which source should I use?', options: [{ label: 'Orders' }, { label: 'Contracts' }] }] },
    } }],
  });
  // Another comment from this turn is not proof that its pending question was routed.
  await post(request, `/api/test/tasks/${taskId}/anchored-comment`, { content: 'The inspection is complete.', author: 'agent', messageId: waiting.id });
  await page.goto(`/task/${taskId}`);
  const drawer = page.getByTestId('task-detail-drawer');
  await expect(drawer).toBeVisible();
  const row = drawer.locator(`[data-testid="task-session-item"][data-message-id="${message.id}"]`);
  await expect(row.getByText('I checked the input.', { exact: true })).toBeVisible();
  await expect(row.getByText('The result is ready.', { exact: true })).toBeVisible();
  await expect(row.getByTestId('task-work-accordion')).toHaveCount(1);
  await expect(row.getByTestId('tool-call-row-completed-read')).toHaveCount(0);
  await expect(drawer.getByTestId('tool-input-form-pending-choice')).toBeVisible();
});
