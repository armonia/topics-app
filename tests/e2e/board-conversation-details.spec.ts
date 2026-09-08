/**
 * Mixed provider turns must not bury a task's conversation under tool traces.
 * The real failure combined native Topics tool names with prose and dozens of
 * tools in a single assistant message, followed by anchored board comments.
 * @covers KANBAN-73
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { hermetic } from './fixtures/hermetic';
import { createTopic, deleteTopic, deleteTask, resetPaneStore } from './helpers/api-fixtures';
import { canonicalTmpDir, removeTmpDir } from './helpers/file-project';
import { projectIdForPath } from '../../shared/board';

hermetic(test);
const projectPath = canonicalTmpDir('e2e-conversation-details');
const projectId = projectIdForPath(projectPath);
const imagePath = `${projectPath}/session-result.svg`;
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

test.beforeAll(() => {
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(imagePath, '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><rect width="240" height="80" fill="#e0ede9"/><text x="20" y="44" fill="#164e3d">Source → Chart</text></svg>');
});
test.beforeEach(async ({ request }) => { await resetPaneStore(request, []); });
test.afterAll(async ({ request }) => {
  for (const id of tasks) await deleteTask(request, projectId, id);
  for (const id of topics) await deleteTopic(request, id);
  removeTmpDir(projectPath);
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
