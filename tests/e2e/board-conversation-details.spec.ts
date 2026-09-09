/**
 * Mixed provider turns must not bury a task's conversation under tool traces.
 * The real failure combined native Topics tool names with prose and dozens of
 * tools in a single assistant message, followed by anchored board comments.
 * @covers KANBAN-05 KANBAN-73
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AxeResults } from 'axe-core';
import { hermetic } from './fixtures/hermetic';
import { createTopic, deleteTopic, deleteTask, resetPaneStore } from './helpers/api-fixtures';
import { canonicalTmpDir, removeTmpDir } from './helpers/file-project';
import { projectIdForPath } from '../../shared/board';
import { testServerEnv } from './helpers/test-server';
import { setTheme } from './helpers/chrome-contrast';
import { interceptWebSocket } from './helpers/ws-helpers';

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

test('an analysis branch offers no merge; a delivery with changes still does', async ({ page, request }) => {
  test.info().annotations.push({ type: 'spec', description: 'KANBAN-05' });
  const { taskId, topicId } = await seed(request, 'Analysis with no code to merge');
  const { message } = await post(request, `/api/test/topics/${topicId}/session-row`, { role: 'assistant', content: 'Analysis complete.' });
  await post(request, `/api/test/tasks/${taskId}/anchored-comment`, {
    content: '```question\nHow should we proceed?\n- Landa su main\n- Continue analysis\n```', author: 'agent', messageId: message.id,
  });
  let filesChanged = 0;
  await page.route(`**/api/boards/${projectId}/tasks/${taskId}`, async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.task = { ...data.task, deliveryBranch: 'task/analysis', deliveryFilesChanged: filesChanged,
      deliveryCommit: filesChanged ? 'delivered-commit' : null, deliveryUncommittedFiles: null };
    await route.fulfill({ response, json: data });
  });
  await page.goto(`/task/${taskId}`);
  const drawer = page.getByTestId('task-detail-drawer');
  await expect(drawer.getByTestId('task-delivery-panel')).toHaveCount(0);
  await drawer.getByTestId('task-delivery-toggle').click();
  await expect(drawer.getByTestId('task-approve')).toBeVisible();
  await expect(drawer.getByTestId('task-send-back')).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Serve a me', exact: true })).toBeVisible();
  await expect(drawer.getByTestId('task-question-options').getByRole('button', { name: 'Continue analysis', exact: true })).toBeVisible();
  await expect(drawer.getByTestId('task-question-options').getByRole('button', { name: 'Landa su main', exact: true })).toHaveCount(0);
  await expect(drawer.getByTestId('task-land')).toHaveCount(0);
  filesChanged = 2;
  await page.reload();
  await drawer.getByTestId('task-delivery-toggle').click();
  await expect(drawer.getByTestId('task-land')).toBeVisible();
  filesChanged = 0;
  await page.reload();
  await drawer.getByTestId('task-delivery-toggle').click();
  await expect(drawer.getByTestId('task-approve')).toBeVisible();
  await expect(drawer.getByTestId('task-land')).toHaveCount(0);
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

test('the final answer stays visible while earlier progress folds; a waiting question remains answerable', async ({ page, request }) => {
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
  await expect(row.getByText('I checked the input.', { exact: true })).toHaveCount(0);
  await expect(row.getByText('The result is ready.', { exact: true })).toBeVisible();
  await expect(row.getByTestId('task-work-accordion')).toHaveCount(1);
  await expect(row.getByTestId('tool-call-row-completed-read')).toHaveCount(0);
  await expect(drawer.getByTestId('tool-input-form-pending-choice')).toBeVisible();
  await row.getByTestId('task-work-summary').click();
  await expect(row.getByText('I checked the input.', { exact: true })).toBeVisible();
  await expect(row.getByTestId('tool-call-row-completed-read')).toBeVisible();
});

test('live progress shares one expandable session detail; a drafted reply sends without stopping the agent', async ({ page, request }, testInfo) => {
  const { taskId, topicId } = await seed(request, 'Follow the work without a tool transcript');
  const answer = 'The source is connected. I am checking the final result.';
  const { message: reply } = await post(request, `/api/test/topics/${topicId}/session-row`, { role: 'assistant', content: '' });
  await post(request, `/api/test/tasks/${taskId}/anchored-comment`, { content: answer, author: 'agent', messageId: reply.id });
  const inProgressAt = new Date().toISOString();
  const progress = [
    { text: 'I am reading the task context.', id: 'live-get-task', name: 'mcp__topics__get_task', args: { task_id: taskId } },
    { text: 'I am inspecting the implementation.', id: 'live-read-source', name: 'Read', args: { file_path: 'source.ts' } },
  ];
  for (const step of progress) {
    await post(request, `/api/test/topics/${topicId}/session-row`, {
      role: 'assistant', content: step.text,
      blocks: [{ kind: 'text', text: step.text }, { kind: 'tool', toolCall: { id: step.id, name: step.name, args: step.args, status: 'success' } }],
    });
  }
  const progressOnly = 'The remaining checks are now running.';
  await post(request, `/api/test/topics/${topicId}/session-row`, { role: 'assistant', content: progressOnly });
  // Present a working task without dispatching a provider. The write routes
  // below are intercepted too: this test exercises the user's gesture only.
  await page.route(`**/api/boards/${projectId}/tasks/${taskId}`, async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.task = { ...data.task, status: 'in_progress', dispatchState: 'working', inProgressAt };
    await route.fulfill({ response, json: data });
  });
  let stops = 0;
  await page.route(`**/api/boards/${projectId}/tasks/${taskId}/stop`, async (route) => {
    stops++;
    await route.fulfill({ json: { ok: true } });
  });
  await page.route(`**/api/boards/${projectId}/tasks/${taskId}/comments`, async (route) => {
    expect(route.request().method()).toBe('POST');
    await route.fulfill({ json: { ok: true } });
  });
  const topicResponse = await request.get('/api/topics');
  expect(topicResponse.ok()).toBe(true);
  const sessionKey = (await topicResponse.json()).topics[topicId]?.sessionKey;
  expect(sessionKey).toBeTruthy();
  const wire = await interceptWebSocket(page);
  await page.goto(`/task/${taskId}`);
  const drawer = page.getByTestId('task-detail-drawer');
  const conversation = drawer.getByTestId('task-session-column');
  const summary = conversation.getByTestId('task-work-summary');
  // The initial summary proves history has loaded before any live frame can
  // arrive; the explicit subscription proves this drawer receives its topic.
  await expect(summary).toHaveCount(1);
  await expect(conversation.getByText(progressOnly, { exact: true })).toHaveCount(0);
  await expect.poll(() => wire.getByType('subscribe').some(({ direction, data }) =>
    direction === 'client' && JSON.parse(data).topicIds?.includes(topicId))).toBe(true);
  const liveText = 'I am verifying the browser result now.';
  const liveId = `task-live-progress-${taskId}`;
  wire.send({ type: 'stream:start', sessionKey, topicId, messageId: liveId });
  wire.send({ type: 'stream:content_chunk', sessionKey, topicId, messageId: liveId, content: liveText });
  wire.send({ type: 'stream:tool_call', sessionKey, topicId, toolCall: {
    id: 'live-shell', name: 'Shell', args: { command: 'inspect browser result' }, status: 'running',
  } });
  await expect(drawer.getByRole('button', { name: 'Ferma', exact: true })).toHaveCount(1);
  await expect(summary).toHaveCount(1);
  await expect(summary).toContainText(/Dettagli sessione|Session details/);
  await expect(summary).toHaveAttribute('aria-expanded', 'false');
  await expect(conversation.getByTestId('task-work-body')).toHaveCount(0);
  await expect(conversation.locator('[data-testid^="tool-call-row-"]')).toHaveCount(0);
  for (const text of [...progress.map((step) => step.text), progressOnly, liveText]) {
    await expect(conversation.getByText(text, { exact: true })).toHaveCount(0);
  }
  await expect(conversation.getByText(answer, { exact: true })).toBeVisible();
  await testInfo.attach('live-session-folded', { body: await page.screenshot({ path: testInfo.outputPath('live-session-folded.png') }), contentType: 'image/png' });
  await summary.click();
  // Seeing the injected row here confirms the live updates were folded,
  // rather than simply dropped while these negative assertions passed.
  for (const text of [...progress.map((step) => step.text), progressOnly, liveText]) {
    await expect(conversation.getByText(text, { exact: true })).toBeVisible();
  }
  await expect(conversation.getByTestId('tool-call-row-live-shell')).toBeVisible();
  for (const step of progress) await expect(conversation.getByTestId(`tool-call-row-${step.id}`)).toHaveCount(1);
  await expect(summary).toHaveCount(1);
  await summary.click();
  await expect(conversation.getByTestId('task-work-body')).toHaveCount(0);
  await expect(conversation.locator('[data-testid^="tool-call-row-"]')).toHaveCount(0);
  await drawer.getByTestId('task-delivery-toggle').click();
  await expect(drawer.getByRole('button', { name: 'Ferma', exact: true })).toHaveCount(1);
  await drawer.getByTestId('task-conversation-toggle').click();
  const input = drawer.getByTestId('task-reply-input');
  const correction = 'Keep the existing source and show the result first.';
  await input.fill(correction);
  const submit = drawer.getByTestId('task-composer-submit');
  await expect(submit).toBeEnabled();
  await expect(submit).not.toHaveAccessibleName('Ferma');
  await expect(drawer.getByRole('button', { name: 'Ferma', exact: true })).toHaveCount(0);
  await testInfo.attach('live-session-correction', { body: await page.screenshot({ path: testInfo.outputPath('live-session-correction.png') }), contentType: 'image/png' });
  const sent = page.waitForResponse((response) => response.url().endsWith(`/tasks/${taskId}/comments`) && response.request().method() === 'POST');
  await submit.click();
  const response = await sent;
  expect(response.ok()).toBe(true);
  expect(response.request().postDataJSON()).toMatchObject({ content: correction });
  expect(response.request().postDataJSON().quiet).not.toBe(true);
  await expect(input).toHaveValue('');
  await expect(drawer.getByRole('button', { name: 'Ferma', exact: true })).toHaveCount(1);
  expect(stops, 'sending a correction must not stop the working agent').toBe(0);
});

test('the floating composer leaves the latest answer readable through multiline drafts and drawer resizing', async ({ page, request }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('board:taskDetailWide', '0'));
  await page.setViewportSize({ width: 1280, height: 800 });
  const { taskId, topicId } = await seed(request, 'Read the answer while writing a correction');
  const { message } = await post(request, `/api/test/topics/${topicId}/session-row`, { role: 'assistant', content: 'Checked the source.' });
  const history = Array.from({ length: 60 }, (_, i) => `Earlier explanation ${i + 1}: the saved query supplies the chart and keeps the source selection available for review.`).join('\n\n');
  await post(request, `/api/test/tasks/${taskId}/anchored-comment`, { content: history, author: 'agent', messageId: message.id });
  const answer = 'Latest answer: the source is ready for your next instruction.';
  await post(request, `/api/test/tasks/${taskId}/anchored-comment`, { content: answer, author: 'agent', messageId: message.id });
  await page.goto(`/task/${taskId}`);
  const drawer = page.getByTestId('task-detail-drawer');
  const scroller = drawer.getByTestId('task-conversation-scroll');
  const overlay = drawer.getByTestId('task-thread-dropzone');
  const composer = drawer.getByTestId('task-composer');
  const input = drawer.getByTestId('task-reply-input');
  const latest = scroller.getByText(answer, { exact: true });
  await expect(latest).toBeVisible();
  await expect(overlay).toHaveCSS('position', 'absolute');
  await expect(composer.getByTestId('task-reply-quiet-note')).toHaveCount(0);
  await expect(drawer.getByTestId('task-reply-quiet-note')).toBeVisible();
  const measurements: unknown[] = [];
  const measure = async () => {
    const [drawerBox, overlayBox, cardBox, inputBox, answerBox, scrollBox, scroll] = await Promise.all([
      drawer.boundingBox(), overlay.boundingBox(), composer.boundingBox(), input.boundingBox(), latest.boundingBox(), scroller.boundingBox(),
      scroller.evaluate((el) => ({ padding: parseFloat(getComputedStyle(el).paddingBottom), remaining: el.scrollHeight - el.scrollTop - el.clientHeight, overflow: el.scrollHeight - el.clientHeight })),
    ]);
    return { drawer: drawerBox!, overlay: overlayBox!, card: cardBox!, input: inputBox!, answer: answerBox!, scroller: scrollBox!, scroll };
  };
  const verify = async (label: string, multiline: boolean) => {
    await expect.poll(async () => {
      const m = await measure();
      return {
        answerAboveOverlay: m.answer.y + m.answer.height <= m.overlay.y + 1,
        answerBelowHeader: m.answer.y >= m.scroller.y - 1,
        cardInset: m.card.x >= m.drawer.x + 7 && m.card.x + m.card.width <= m.drawer.x + m.drawer.width - 7,
        paddingMatchesOverlay: m.scroll.padding >= m.overlay.height + 20,
        followsLatest: m.scroll.remaining <= 2,
        inputBounded: m.input.height >= 32 && m.input.height <= 140 && (!multiline || m.input.height > 60),
      };
    }, { message: `${label}: the last answer must remain above the measured floating composer` }).toEqual({
      answerAboveOverlay: true, answerBelowHeader: true, cardInset: true, paddingMatchesOverlay: true, followsLatest: true, inputBounded: true,
    });
    expect((await measure()).scroll.overflow, 'fixture must exercise an overflowing conversation').toBeGreaterThan(0);
    expect(await drawer.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    measurements.push({ label, ...(await measure()) });
  };
  const draft = Array.from({ length: 12 }, (_, i) => `Correction ${i + 1}: preserve the source and explain the result.`).join('\n');
  for (const viewport of [{ width: 375, height: 844 }, { width: 768, height: 900 }, { width: 1280, height: 800 }, { width: 1600, height: 900 }]) {
    await page.setViewportSize(viewport);
    if (viewport.width === 1600) {
      await drawer.getByTestId('task-detail-wide-toggle').click();
      await expect(drawer.getByTestId('task-detail-wide-toggle')).toHaveAttribute('aria-pressed', 'true');
      await expect(drawer.getByTestId('task-workspace-toggle')).toHaveAttribute('data-open', '0');
    }
    const label = viewport.width === 1600 ? '1600-wide' : String(viewport.width);
    // On subsequent viewports, keep the existing multiline draft during the
    // resize. No scroll reset can hide a broken follow/measurement lifecycle.
    await verify(`${label}-resized`, viewport.width !== 375);
    await input.fill('');
    await verify(`${label}-empty`, false);
    await input.fill(draft);
    await verify(`${label}-multiline`, true);
    await testInfo.attach(`floating-composer-${label}`, { body: await page.screenshot({ path: testInfo.outputPath(`floating-composer-${label}.png`) }), contentType: 'image/png' });
  }
  // A short wrapped draft must also shrink when the panel widens; a field
  // stuck at the previous width's line count wastes the conversation's space.
  await page.setViewportSize({ width: 375, height: 844 });
  const shortDraft = 'Keep the source selected for this chart. Explain which saved query supplies its data and where I can edit it. Preserve the existing filters and show the result before the technical details.';
  await input.fill(shortDraft);
  await expect(input).toHaveValue(shortDraft);
  const narrowHeight = (await input.boundingBox())!.height;
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect(input).toHaveValue(shortDraft);
  await expect.poll(async () => (await input.boundingBox())!.height).toBeLessThan(narrowHeight);
  await testInfo.attach('floating-composer-geometry', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
});

test('the current question is actionable once; history and centered status stay readable on a narrow screen', async ({ page, request }, testInfo) => {
  const { taskId, topicId } = await seed(request, 'Choose the next source');
  const oldQuestion = 'Which data do you need? See the [source guide](/source-guide).';
  const question = 'How should we add the source?';
  const { message: first } = await post(request, `/api/test/topics/${topicId}/session-row`, { role: 'assistant', content: 'Checked the available data.' });
  await post(request, `/api/test/tasks/${taskId}/anchored-comment`, { content: `\`\`\`question\n${oldQuestion}\n- Old choice\n\`\`\``, author: 'agent', messageId: first.id });
  await post(request, `/api/boards/${projectId}/tasks/${taskId}/comments`, { content: 'Please explain the source.', quiet: true });
  const { message } = await post(request, `/api/test/topics/${topicId}/session-row`, { role: 'assistant', content: 'Inspected the source registry.' });
  await post(request, `/api/test/tasks/${taskId}/anchored-comment`, { content: 'The chart can already read a saved query.', author: 'agent', messageId: message.id });
  await post(request, `/api/test/tasks/${taskId}/anchored-comment`, { content: `\`\`\`question\n${question}\n- **Build the source editor**\n- Load the selected source\n\`\`\``, author: 'agent', messageId: message.id });
  const { comment: delivery } = await post(request, `/api/test/tasks/${taskId}/anchored-comment`, { content: 'The source explanation is ready.', author: 'agent', messageId: message.id });
  const reason = 'The first explanation did not identify which source the chart would use, so the user requested a clearer description before proceeding.';
  await page.route(`**/api/boards/${projectId}/tasks/${taskId}`, async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.task.reopenedAt = new Date().toISOString();
    data.task.reopenedActor = 'human';
    data.comments = data.comments.map((comment: { id: string; kind: string; content: string }) => comment.id === delivery.id
      ? { ...comment, kind: 'delivery' }
      : comment.kind === 'status' ? { ...comment, content: `in_progress→review · ${reason}` } : comment);
    await route.fulfill({ response, json: data });
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/task/${taskId}`);
  const drawer = page.getByTestId('task-detail-drawer');
  const conversation = drawer.getByTestId('task-session-column');
  const choices = drawer.getByTestId('task-question-options');
  await expect(choices).toHaveCount(1);
  await expect(drawer.getByTestId('task-send-back')).toHaveCount(0);
  await expect(drawer.getByTestId('task-delivery-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(conversation.getByRole('button', { name: 'Build the source editor', exact: true })).toBeVisible();
  await expect(drawer.getByText('Build the source editor', { exact: true })).toHaveCount(1);
  const past = drawer.getByTestId('task-past-question');
  await expect(past).toHaveCount(1);
  await expect(past).not.toHaveAttribute('open', '');
  await expect(past.getByText('Old choice', { exact: true })).not.toBeVisible();
  await past.locator('summary').click();
  await expect(past.getByText('Old choice', { exact: true })).toBeVisible();
  await expect(past.getByRole('link', { name: 'source guide' })).toHaveAttribute('href', '/source-guide');
  await past.locator('summary').click();
  await expect(drawer.getByTestId('task-delivery-note')).not.toHaveAttribute('open', '');
  await page.screenshot({ path: testInfo.outputPath('conversation-desktop.png') });
  const input = drawer.getByTestId('task-reply-input');
  await input.fill('Explain which source supplies the chart.');
  const quietNote = drawer.getByTestId('task-reply-quiet-note');
  await expect(quietNote).toBeEnabled();
  await expect(drawer.getByTestId('task-composer').getByTestId('task-reply-quiet-note')).toHaveCount(0);
  await drawer.getByTestId('task-delivery-toggle').click();
  await expect(drawer.getByTestId('task-delivery-panel')).toBeVisible();
  await expect(drawer.getByTestId('task-delivery-panel').getByTestId('task-send-back')).toBeVisible();
  await page.addScriptTag({ path: resolve('node_modules/axe-core/axe.min.js') });
  for (const dark of [false, true]) {
    await setTheme(page, dark);
    const violations = await page.evaluate(async () => {
      const axe = (window as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<AxeResults> } }).axe;
      const result = await axe.run({ include: [
        ['[data-testid="task-conversation-toggle"]'], ['[data-testid="task-details-toggle"]'],
        ['[data-testid="task-delivery-toggle"]'], ['[data-testid="task-workspace-toggle"]'],
        ['[data-testid="task-composer"]'], ['[data-testid="task-reply-quiet-note"]'],
        ['[data-testid="task-question-options"]'], ['[data-testid="task-delivery-panel"]'],
      ] }, { runOnly: ['wcag2a', 'wcag2aa'] });
      return result.violations.map(({ id, nodes }) => ({ id, nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })) }));
    });
    expect(violations, `conversation controls in ${dark ? 'dark' : 'light'} theme`).toEqual([]);
    await testInfo.attach(`conversation-controls-${dark ? 'dark' : 'light'}`, {
      body: await page.screenshot({ path: testInfo.outputPath(`conversation-controls-${dark ? 'dark' : 'light'}.png`) }), contentType: 'image/png',
    });
  }

  await drawer.getByTestId('task-conversation-toggle').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await input.fill('Explain which source supplies the chart.\nKeep the SQL details in the expandable session.\nInclude a concrete example.');
  await expect(input).toHaveAccessibleName(/correzione|correction/);
  await expect(drawer.getByTestId('task-composer').getByTestId('task-composer-submit')).toHaveAccessibleName(/Invia all.agente|Send to agent/);
  const inputBox = await input.boundingBox();
  expect(inputBox!.height).toBeGreaterThan(60);
  expect(inputBox!.height).toBeLessThanOrEqual(140);
  expect(await drawer.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await expect(drawer.getByTestId('task-status-trail').first()).toHaveCSS('justify-content', 'center');
  const status = drawer.getByTestId('task-status-event').first();
  await expect(status).toContainText(reason);
  expect(await status.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  const reopened = drawer.getByTestId('task-reopened-notice');
  await reopened.locator('summary').click();
  await expect(reopened.locator('p')).toBeVisible();
  await reopened.locator('summary').click();
  await page.screenshot({ path: testInfo.outputPath('conversation-mobile-correction.png') });
  await input.fill('');
  const answer = page.waitForResponse((response) => response.url().endsWith(`/tasks/${taskId}/comments`) && response.request().method() === 'POST');
  await choices.getByRole('button', { name: 'Build the source editor', exact: true }).click();
  const answered = await answer;
  expect(answered.ok()).toBe(true);
  expect(answered.request().postDataJSON().content).toBe('**Build the source editor**');
  await expect(choices).toHaveCount(0);
});

test('a single-line system question keeps its inline answers in the conversation', async ({ page, request }) => {
  const { taskId, topicId } = await seed(request, 'Answer a system question');
  const { message } = await post(request, `/api/test/topics/${topicId}/session-row`, { role: 'assistant', content: 'Waiting for a choice.' });
  await post(request, `/api/test/tasks/${taskId}/anchored-comment`, { content: '```question Which source? - Contracts - Orders```', author: 'system', messageId: message.id });
  await page.goto(`/task/${taskId}`);
  const conversation = page.getByTestId('task-session-column');
  await expect(conversation.getByTestId('task-question-options').getByRole('button', { name: 'Contracts', exact: true })).toBeVisible();
  await expect(conversation.getByRole('button', { name: 'Orders', exact: true })).toBeVisible();
});

for (const gesture of ['button', 'enter', 'attachment'] as const) {
  test(`a correction sent by ${gesture} reaches the agent with the same text`, async ({ page, request }) => {
    const { taskId } = await seed(request, `Correct the task using ${gesture}`);
    await page.goto(`/task/${taskId}`);
    const drawer = page.getByTestId('task-detail-drawer');
    const input = drawer.getByTestId('task-reply-input');
    const correction = `Use the contracts source and explain the result (${gesture}).`;
    await input.fill(correction);
    let media: string[] = [];
    if (gesture === 'attachment') {
      const uploaded = page.waitForResponse((response) => response.url().includes('/api/upload') && response.request().method() === 'POST');
      await drawer.locator('input[type="file"]').setInputFiles({ name: 'source.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC', 'base64') });
      expect((await uploaded).ok()).toBe(true);
      await expect(drawer.getByTestId('task-composer-submit')).toBeEnabled();
    }
    const sent = page.waitForResponse((response) => response.url().endsWith(`/tasks/${taskId}/comments`) && response.request().method() === 'POST');
    if (gesture === 'enter') await input.press('Enter');
    else await drawer.getByTestId('task-composer-submit').click();
    const response = await sent;
    expect(response.ok()).toBe(true);
    const payload = response.request().postDataJSON();
    expect(payload.content).toBe(correction);
    expect(payload.quiet).not.toBe(true);
    if (gesture === 'attachment') {
      media = payload.media;
      expect(media).toHaveLength(1);
    }
    await expect(input).toHaveValue('');
    const stored = await request.get(`/api/boards/${projectId}/tasks/${taskId}`);
    const data = await stored.json();
    expect(data.task.status).toBe('in_progress');
    const comment = data.comments.find((entry: { content: string }) => entry.content === correction);
    expect(comment).toBeTruthy();
    if (gesture === 'attachment') expect(comment.media).toEqual(media);
  });
}
