/**
 * A TASK TOPIC'S STRIP OPENS ITS ROWS WHERE THEIR COUNTS CAME FROM.
 *
 * On a topic a task was dispatched to, the strip lists the task's own diff
 * range: after the land that is the land merge, read in the project's
 * checkout. A row used to open the editor's diff there, which compares HEAD
 * with the disk, so the counts said `+2` and the diff that opened was empty
 * (or, in a shared checkout, somebody else's work in progress). The strip now
 * draws the topic's changeset, which on a card's topic IS the drawer's range:
 * the row opens the drawer's lines in place, and «Open in the card» takes the
 * same file to the drawer, where review notes are written.
 *
 * What this walks: a card that landed by merge and whose worktree is gone, a
 * chat whose Write names a path inside that pruned worktree, the strip drawing
 * the file repo-relative with the drawer's lines, and the link landing on the
 * drawer's changes panel with that file focused.
 *
 * @covers CHAT-CHANGES-01, CHGSET-03
 */
import { expect } from '@playwright/test';
import { test } from './fixtures/chat.fixture';
import { hermetic } from './fixtures/hermetic';
import { createTopic, deleteTask, deleteTopic, resetPaneStore } from './helpers/api-fixtures';
import { seedMessage } from './helpers/seed-messages';
import { E2E_BASE } from './helpers/test-server';
import { projectIdForPath } from '../../shared/board';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { removeTmpDir } from './helpers/file-project';

hermetic(test);

const STAMP = Date.now();
/** The real path: `/tmp` is a symlink on macOS and git answers resolved. */
const PROJECT_PATH = `${realpathSync('/tmp')}/e2e-chat-range-${STAMP}`;
const PROJECT_ID = projectIdForPath(PROJECT_PATH);
const WORKTREE_NAME = `chat-range-${STAMP}`;
const BRANCH = `topics/${WORKTREE_NAME}`;
/** Where the agent worked, laid out as `worktree-manager.ts` lays it out
 *  (`<worktrees>/<slug>/<name>` on `topics/<name>`), and already pruned by the
 *  land: it never exists on disk here. The delivery branch names it. */
const PRUNED_WORKTREE = `${PROJECT_PATH}-worktrees/${WORKTREE_NAME}`;
const FILE = 'src/a.ts';
const SHOTS = 'test-results/chat-changed-files-task-range';

let topicId = '';
let taskId = '';

const git = (...args: string[]) =>
  execFileSync('git', ['-C', PROJECT_PATH, ...args], { encoding: 'utf8' }).trim();

test.beforeAll(async ({ request }) => {
  mkdirSync(`${PROJECT_PATH}/src`, { recursive: true });
  writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: 'e2e-chat-range' }));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');

  const topic = await createTopic(request, `chat-range-${STAMP}`, { projectPath: PROJECT_PATH });
  topicId = topic.id;
  const created = await request.post(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks`, {
    data: { text: 'consegna atterrata', status: 'review' },
  });
  taskId = ((await created.json()) as { id: string }).id;

  // The card's work, landed the way the land does it (`merge --no-ff` with
  // the card's id in the subject), and its branch pruned.
  git('checkout', '-q', '-b', BRANCH);
  writeFileSync(`${PROJECT_PATH}/${FILE}`, 'export const a = 1;\nexport const b = 2;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'the delivery');
  git('checkout', '-q', 'main');
  const delivered = git('rev-parse', BRANCH);
  git('merge', '--no-ff', '-q', '-m', `merge task ${taskId}: consegna atterrata`, BRANCH);
  git('branch', '-q', '-D', BRANCH);

  const bound = await request.post(`${E2E_BASE}/api/test/tasks/${taskId}/bind-topic`, { data: { topicId } });
  expect(bound.ok(), `bind-topic: ${bound.status()} ${await bound.text()}`).toBe(true);
  // The delivery the review records: after the prune its branch is the only
  // name left of the worktree the Write below points into.
  const recorded = await request.post(`${E2E_BASE}/api/test/tasks/${taskId}/landing`, {
    data: { branch: BRANCH, commit: delivered },
  });
  expect(recorded.ok(), `landing: ${recorded.status()} ${await recorded.text()}`).toBe(true);

  const list = await request.get(`${E2E_BASE}/api/topics`, { ignoreHTTPSErrors: true });
  const { topics } = (await list.json()) as { topics: Record<string, { sessionKey: string }> };
  const sessionKey = topics[topicId]?.sessionKey;
  if (!sessionKey) throw new Error(`topic ${topicId} has no sessionKey: nothing to seed into`);
  await seedMessage(request, {
    sessionKey,
    role: 'assistant',
    content: 'fatto',
    toolCalls: [
      { id: 'tc-a', name: 'Write', args: { file_path: `${PRUNED_WORKTREE}/${FILE}` }, status: 'success' },
    ],
  });

  // The route answers before the browser is asked to draw it: an empty strip
  // must not accuse the click when the range was never found.
  const changes = await request.get(`${E2E_BASE}/api/topics/${topicId}/changes`);
  const body = (await changes.json()) as { files: Array<{ path: string; added?: number; inRange?: boolean }>; taskId?: string };
  expect(body.taskId, `the changes route sees: ${JSON.stringify(body)}`).toBe(taskId);
  expect(body.files).toEqual([expect.objectContaining({ path: FILE, added: 2, inRange: true })]);
});

test.afterAll(async ({ request }) => {
  // The card goes too: a `review` card left on the shared server is counted by
  // every later spec that reads the board's totals (TILE-15, NH-01).
  if (taskId) await deleteTask(request, PROJECT_ID, taskId);
  if (topicId) await deleteTopic(request, topicId).catch(() => undefined);
  removeTmpDir(PROJECT_PATH);
});

test("a row of a task topic strip opens the card's lines in the strip, and the link opens the drawer on that file", async ({ page }) => {
  test.setTimeout(90_000);
  // By permalink: a topic bound to a project has no top-level sidebar row
  // (see git-rows-one-shape.spec.ts).
  await resetPaneStore(page.request, [topicId]);
  const opened = await page.goto(`/tab/chat/${topicId}`);
  expect(opened?.status()).toBe(200);
  await page.waitForSelector('[aria-label="Topics sidebar"]', { state: 'visible', timeout: 20_000 });

  const chip = page.getByTestId('chat-changes-chip');
  await expect(chip).toBeVisible({ timeout: 20_000 });
  await chip.click();
  const file = page.getByTestId('chat-changes-diff').locator(`[data-testid="diff-file"][data-path="${FILE}"]`);
  await expect(file).toBeVisible({ timeout: 15_000 });
  await file.getByRole('button', { name: /a\.ts/ }).click();
  // The land merge's lines, the ones the drawer draws: in the strip, not in the editor.
  await expect(file).toContainText('+export const b = 2;', { timeout: 15_000 });
  await expect(page.getByTestId('file-pane')).toHaveCount(0);
  await page.getByTestId('chat-changes-strip').screenshot({ path: `${SHOTS}/strip.png` });

  await page.getByTestId('chat-changes-open-card').click();
  // The drawer of THAT task, on its changes panel, with THAT file focused and
  // its patch drawn: the same changeset the strip showed.
  const drawer = page.getByTestId('task-detail-drawer');
  await expect(drawer).toBeVisible({ timeout: 20_000 });
  const panel = page.getByTestId('task-changes-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  const focused = panel.locator(`[data-testid="diff-file"][data-path="${FILE}"]`);
  await expect(focused).toHaveAttribute('data-focused', '1', { timeout: 20_000 });
  await expect(focused).toContainText('export const b = 2;', { timeout: 20_000 });
  await page.screenshot({ path: `${SHOTS}/drawer-focused-file.png` });
});
