/**
 * EVERY CHANGED FILE, AND EACH ONE READABLE, FROM THE CARD.
 *
 * Asked on 23/09: every surface that lists changed files shows ALL of them,
 * with a preview you can use. What a unit test cannot see, and this walks:
 *  1. the chip's number: the DB counter until the list is read, the list's own
 *     count after (task 1c19bf48 said 101 over a list of 34);
 *  2. «and N more» is a button, and a long list has a filter over ALL rows;
 *  3. a row opens the task on THAT file's diff, and a file past the bundle's
 *     payload cap loads its own patch (task 7657f201: 30 of 74 had none).
 *
 * WebKit: the engine the app ships in, and the only one this Mac runs.
 * @covers GIT-FILELIST-01, KANBAN-43
 */
import { expect, type Page } from '@playwright/test';
import { test } from './fixtures/chat.fixture';
import { hermetic } from './fixtures/hermetic';
import { createTopic, deleteTopic } from './helpers/api-fixtures';
import { projectRow } from './helpers/project-row';
import { E2E_BASE } from './helpers/test-server';
import { projectIdForPath } from '../../shared/board';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { removeTmpDir } from './helpers/file-project';

hermetic(test);

const STAMP = Date.now();
/** The real path: `/tmp` is a symlink on macOS and git answers resolved. */
const PROJECT_PATH = `${realpathSync('/tmp')}/e2e-changed-all-${STAMP}`;
const PROJECT_NAME = `e2e-changed-all-${STAMP}`;
const BRANCH = `topics/changed-all-${STAMP}`;
const PROJECT_ID = projectIdForPath(PROJECT_PATH);
const SHOTS = 'test-results/changed-files-complete';
/** Sorted first and bigger than the bundle's 200 KB: every file after it
 *  arrives with no patch. */
const BIG = 'a-big.txt';
/** 15 small files: more than the list's 12, all past the payload cap. */
const SMALL = Array.from({ length: 15 }, (_, i) => `src/file-${String(i).padStart(2, '0')}.ts`);
const LAST = SMALL[SMALL.length - 1]!;
/** The stale counter a real delivery can carry: nothing like the real diff. */
const STALE_COUNT = 101;

let taskId = '';
let topicId = '';

const git = (...args: string[]) =>
  execFileSync('git', ['-C', PROJECT_PATH, ...args], { encoding: 'utf8' }).trim();

test.beforeAll(async ({ request }) => {
  mkdirSync(`${PROJECT_PATH}/src`, { recursive: true });
  writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: 'e2e-changed-all' }));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', BRANCH);
  writeFileSync(`${PROJECT_PATH}/${BIG}`, Array.from({ length: 12_000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n') + '\n');
  for (const f of SMALL) writeFileSync(`${PROJECT_PATH}/${f}`, `export const v = '${f}';\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'the delivery');
  const commit = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');

  // A topic on the folder is what makes it a PROJECT the server knows: the
  // diff route finds the repository through the project list.
  topicId = (await createTopic(request, `changed-all-${STAMP}`, { projectPath: PROJECT_PATH })).id;

  const created = await request.post(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks`, {
    data: { text: 'consegna con molti file', status: 'review' },
  });
  taskId = ((await created.json()) as { id: string }).id;
  const delivered = await request.post(`${E2E_BASE}/api/test/tasks/${taskId}/delivery`, {
    data: { branch: BRANCH, commit, filesChanged: STALE_COUNT, insertions: 999, deletions: 0 },
  });
  expect(delivered.ok(), `delivery not recorded: ${delivered.status()}`).toBe(true);

  // The route answers before the browser is asked to draw it.
  const diff = await request.get(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks/${taskId}/diff`);
  const bundle = (await diff.json()) as { stat?: Array<{ path: string }>; truncated?: boolean; patch?: string };
  expect(bundle.stat?.length, JSON.stringify(bundle.stat?.map((s) => s.path))).toBe(SMALL.length + 1);
  expect(bundle.truncated).toBe(true);
  expect(bundle.patch ?? '').not.toContain(`b/${LAST}`);
});

test.afterAll(async ({ request }) => {
  if (topicId) await deleteTopic(request, topicId).catch(() => undefined);
  removeTmpDir(PROJECT_PATH);
});

test('il chip della card: numero vero, tutti i file, e ogni file si apre col suo diff', async ({ page }) => {
  await openProjectWindow(page);
  await openBoardPane(page);
  const card = page.locator(`[data-task-card="${taskId}"]`);
  await expect(card).toBeVisible({ timeout: 20_000 });
  const toggle = card.getByTestId('card-delivery-files-toggle');

  // 1. Before the read: the counter. After: what the list has.
  await expect(toggle).toContainText(String(STALE_COUNT), { timeout: 20_000 });
  await toggle.click();
  const list = card.getByTestId('card-delivery-files-list');
  await expect(list.getByTestId('changed-file-row')).toHaveCount(12, { timeout: 25_000 });
  await expect(toggle).toContainText(String(SMALL.length + 1));
  await expect(toggle).not.toContainText(String(STALE_COUNT));

  // 2. The tail opens, and the filter searches every row.
  await list.getByTestId('changed-file-more').click();
  await expect(list.getByTestId('changed-file-row')).toHaveCount(SMALL.length + 1);
  await list.getByTestId('changed-file-filter').fill('file-14');
  await expect(list.getByTestId('changed-file-row')).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/chip-filtered.png` });

  // 3. The row opens the task on THAT file, and its patch (past the cap)
  //    loads by itself.
  await list.locator(`[data-testid="changed-file-row"][data-path="${LAST}"]`).click();
  const drawer = page.getByTestId('task-detail-drawer');
  await expect(drawer).toBeVisible({ timeout: 20_000 });
  const panel = page.getByTestId('task-changes-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  const focused = panel.locator(`[data-testid="diff-file"][data-path="${LAST}"]`);
  await expect(focused).toHaveAttribute('data-focused', '1');
  await expect(focused).toContainText(`export const v = '${LAST}';`, { timeout: 20_000 });
  await expect(focused).toBeInViewport();
  await page.screenshot({ path: `${SHOTS}/drawer-focused-file.png` });

  // A different file past the cap, opened by hand: the button loads it.
  const other = panel.locator(`[data-testid="diff-file"][data-path="${SMALL[0]}"]`);
  await other.locator('button').first().click();
  await other.getByTestId('diff-load-file').click();
  await expect(other).toContainText(`export const v = '${SMALL[0]}';`, { timeout: 20_000 });
});

/** The project's own window, from the sidebar row. */
async function openProjectWindow(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });
  const section = page.getByRole('button', { name: /sezione Progetti/ });
  if ((await section.count()) > 0 && (await section.getAttribute('aria-expanded')) === 'false') await section.click();
  const row = projectRow(page, new RegExp(PROJECT_NAME));
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(page.getByTestId('project-window')).toBeVisible({ timeout: 20_000 });
}

/** Add the board pane to the open project window. */
async function openBoardPane(page: Page): Promise<void> {
  const triggers = page.getByTestId('pane-add-menu-trigger');
  const entry = page.getByTestId('pane-add-menu-kanban');
  for (let i = (await triggers.count()) - 1; i >= 0; i--) {
    const trigger = triggers.nth(i);
    if (!(await trigger.isVisible().catch(() => false))) continue;
    if (!(await trigger.click({ timeout: 3000 }).then(() => true, () => false))) continue;
    if (await entry.waitFor({ state: 'visible', timeout: 2000 }).then(() => true, () => false)) {
      await entry.click();
      return;
    }
    await page.keyboard.press('Escape');
  }
  if (await page.locator('[data-testid^="kanban-column-"]').first().isVisible().catch(() => false)) return;
  throw new Error('the board was not found');
}
