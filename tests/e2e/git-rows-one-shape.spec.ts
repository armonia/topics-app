/**
 * THE SAME REPOSITORY, THE SAME ROWS, ON TWO SURFACES.
 *
 * The list of files git touched used to be drawn four times over: the strip
 * above the composer, the delivery chip of a board card, the header of a diff
 * and the project's git panel. Four copies is not a tidiness problem: the
 * delivery chip showed `+/-` for a file it never said had been DELETED, and the
 * chat strip cut the path from the right, eating the file name.
 *
 * What is pinned here is the thing a unit test cannot see: two DIFFERENT
 * surfaces, mounted in the same app against the same repository, drawing the
 * same row -- same locator (`changed-file-row`), same paths, same letters. If
 * one of them ever forks its own copy again, one of the two halves goes red.
 *
 * @covers GIT-FILELIST-01
 */
import { expect, type Page } from '@playwright/test';
import { test } from './fixtures/chat.fixture';
import { hermetic } from './fixtures/hermetic';
import { createTopic, deleteTopic, resetPaneStore } from './helpers/api-fixtures';
import { seedMessage } from './helpers/seed-messages';
import { projectRow } from './helpers/project-row';
import { E2E_BASE } from './helpers/test-server';
import { projectIdForPath } from '../../shared/board';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

hermetic(test);

const STAMP = Date.now();
const PROJECT_PATH = `/tmp/e2e-git-rows-${STAMP}`;
const PROJECT_ID = projectIdForPath(PROJECT_PATH);
/** The two files both surfaces have to agree on: one added, one modified. */
const ADDED = 'src/added.ts';
const MODIFIED = 'src/base.ts';

let topicId = '';
let taskId = '';

const git = (...args: string[]) =>
  execFileSync('git', ['-C', PROJECT_PATH, ...args], { encoding: 'utf8' }).trim();

test.beforeAll(async ({ request }) => {
  // A REAL REPOSITORY, with a real delivery commit: the NAMES the card shows
  // are read from git when the dropdown opens, so an invented sha would give
  // an honest "no files" and prove nothing.
  mkdirSync(`${PROJECT_PATH}/src`, { recursive: true });
  writeFileSync(`${PROJECT_PATH}/package.json`, JSON.stringify({ name: 'e2e-git-rows' }));
  writeFileSync(`${PROJECT_PATH}/${MODIFIED}`, 'export const one = 1;\n');
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  writeFileSync(`${PROJECT_PATH}/${MODIFIED}`, 'export const one = 1;\nexport const two = 2;\n');
  writeFileSync(`${PROJECT_PATH}/${ADDED}`, 'export const three = 3;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'the delivery');
  const commit = git('rev-parse', 'HEAD');

  const topic = await createTopic(request, `git-rows-${STAMP}`, { projectPath: PROJECT_PATH });
  topicId = topic.id;

  // The chat side: the strip reads the topic's write tool calls, crossed with
  // git. The two paths are the ones the commit carries, so the two surfaces
  // are answering about the same work.
  const list = await request.get(`${E2E_BASE}/api/topics`, { ignoreHTTPSErrors: true });
  const { topics } = (await list.json()) as { topics: Record<string, { sessionKey: string }> };
  const sessionKey = topics[topicId]?.sessionKey;
  if (!sessionKey) throw new Error(`topic ${topicId} has no sessionKey: nothing to seed into`);
  await seedMessage(request, {
    sessionKey,
    role: 'assistant',
    content: 'fatto',
    toolCalls: [
      { id: 'tc-a', name: 'Write', args: { file_path: `${PROJECT_PATH}/${ADDED}` }, status: 'success' },
      { id: 'tc-m', name: 'Edit', args: { file_path: `${PROJECT_PATH}/${MODIFIED}` }, status: 'success' },
    ],
  });

  // The board side: a delivered card on the same project. The counters are
  // written by the real service through the test door (a PATCH would not take
  // them: they are MEASURED, not declared).
  const created = await request.post(`${E2E_BASE}/api/boards/${PROJECT_ID}/tasks`, {
    data: { text: 'la consegna da rivedere', status: 'review' },
  });
  taskId = ((await created.json()) as { id: string }).id;
  const delivered = await request.post(`${E2E_BASE}/api/test/tasks/${taskId}/delivery`, {
    data: { branch: 'main', commit, filesChanged: 2, insertions: 2, deletions: 0 },
  });
  expect(delivered.ok(), `delivery not recorded: ${delivered.status()} ${await delivered.text()}`).toBe(true);

  // BOTH ROUTES ANSWER BEFORE THE BROWSER IS ASKED TO DRAW THEM. Without this,
  // an empty strip accuses the shared component when the fault is a repository
  // the server never found.
  const changes = await request.get(`${E2E_BASE}/api/topics/${topicId}/changes`);
  const body = (await changes.json()) as { files: Array<{ path: string }>; git: unknown };
  expect(body.files.map((f) => f.path).sort(), `the changes route sees: ${JSON.stringify(body)}`)
    .toEqual([ADDED, MODIFIED]);
});

test.afterAll(async ({ request }) => {
  if (topicId) await deleteTopic(request, topicId).catch(() => undefined);
  rmSync(PROJECT_PATH, { recursive: true, force: true });
});

/** The rows of a list, as `mark path` pairs, in the order they are drawn. */
async function rowsOf(scope: ReturnType<Page['locator']>): Promise<string[]> {
  const rows = scope.getByTestId('changed-file-row');
  const out: string[] = [];
  for (let i = 0; i < (await rows.count()); i++) {
    const row = rows.nth(i);
    const path = await row.getAttribute('data-path');
    const mark = await row.locator('[data-changed-file-mark]').first().getAttribute('data-changed-file-mark');
    out.push(`${mark} ${path}`);
  }
  return out.sort();
}

test.describe('la stessa lista di file su due superfici', () => {
  test('la striscia della chat e il chip della card disegnano le stesse righe', async ({ page }) => {
    // ── SURFACE ONE: the strip above the composer.
    //
    // Reached by PERMALINK, not from the sidebar: a topic bound to a project is
    // nested under that project, so neither its `treeitem` nor its `pane-tab`
    // resolves at the top level (measured: two runs, 30s of waiting each).
    await resetPaneStore(page.request, [topicId]);
    const opened = await page.goto(`/tab/chat/${topicId}`);
    expect(opened?.status(), 'the permalink has to be addressable by the server').toBe(200);
    await page.waitForSelector('[aria-label="Topics sidebar"]', { state: 'visible', timeout: 20_000 });
    await expect(page.getByTestId(`pane-tab-${topicId}`)).toBeVisible({ timeout: 20_000 });

    const chip = page.getByTestId('chat-changes-chip');
    await expect(chip).toBeVisible({ timeout: 20_000 });
    await chip.click();
    const chatList = page.getByTestId('chat-changes-list').first();
    await expect(chatList.getByTestId('changed-file-row')).toHaveCount(2, { timeout: 15_000 });
    const chatRows = await rowsOf(chatList);
    // The mark is the shared component's, and it says WHAT happened: the file
    // the turn created is an `A`, the one it edited an `M`.
    expect(chatRows).toEqual([`A ${ADDED}`, `M ${MODIFIED}`]);

    // ── SURFACE TWO: the delivery chip of the card, same repository.
    await openBoard(page);
    const card = page.locator(`[data-task-card="${taskId}"]`);
    await expect(card).toBeVisible({ timeout: 20_000 });
    const toggle = card.getByTestId('card-delivery-files-toggle');
    await expect(toggle).toBeVisible({ timeout: 20_000 });
    await toggle.click();
    const cardList = card.getByTestId('card-delivery-files-list');
    await expect(cardList.getByTestId('changed-file-row')).toHaveCount(2, { timeout: 25_000 });

    // THE POINT OF THE WHOLE SPEC: byte for byte the same rows, from two
    // surfaces that read git through two different routes.
    expect(await rowsOf(cardList)).toEqual(chatRows);
  });
});

/** Open the project's board pane, from the sidebar. */
async function openBoard(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('[aria-label="Topics sidebar"]').first()).toBeVisible({ timeout: 20_000 });
  const section = page.getByRole('button', { name: /sezione Progetti/ });
  if ((await section.count()) > 0 && (await section.getAttribute('aria-expanded')) === 'false') await section.click();
  const row = projectRow(page, /e2e-git-rows/);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(page.getByTestId('project-window')).toBeVisible({ timeout: 20_000 });

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
