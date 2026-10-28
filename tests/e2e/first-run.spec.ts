/**
 * @covers FIRST-RUN-02
 * @covers FIRST-RUN-03
 */
import { expect, test, type Page } from '@playwright/test';
import { hermetic } from './fixtures/hermetic';
import { openProfileMenu } from './helpers/open-perf-panel';

hermetic(test);

/** Gives the owner a name and clears the first-run flag, so the next load decides afresh. */
async function resetFirstRun(page: Page, ownerName: string) {
  const people = await (await page.request.get('/api/people?stats=0')).json() as { people: Array<{ id: string; isMe?: boolean }> };
  const owner = people.people.find((person) => person.isMe);
  expect(owner, 'the owner is in the address book').toBeTruthy();
  expect((await page.request.patch(`/api/auth/people/${owner!.id}`, { data: { name: ownerName } })).ok()).toBe(true);
  const response = await page.request.put('/api/app-settings', { data: { firstRunDoneAt: null } });
  expect(response.ok()).toBe(true);
  await page.reload();
}

/** A first opening: the owner still has the name it was born with (migration 084). */
async function clearFirstRun(page: Page) {
  await resetFirstRun(page, 'Proprietario');
  await expect(page.getByTestId('first-run')).toBeVisible();
  // The welcome plays first; the setup is one press away.
  await page.getByTestId('first-run-start').click();
  await expect(page.getByTestId('first-run')).toHaveAttribute('data-step', 'setup');
}

test.describe('first-run @covers FIRST-RUN-01', () => {
  test('saves the owner name and opens the app', async ({ page }) => {
    await page.goto('/');
    await clearFirstRun(page);
    await page.getByTestId('first-run-name').fill('Ada Topics');
    await page.getByTestId('first-run-save-name').click();
    await expect(page.getByTestId('first-run-name')).toHaveValue('Ada Topics');
    const peopleAfterSave = await (await page.request.get('/api/people?stats=0')).json() as { people: Array<{ displayName: string; isMe?: boolean }> };
    expect(peopleAfterSave.people.find((person) => person.isMe)?.displayName).toBe('Ada Topics');
    await page.getByTestId('first-run-done').click();
    await expect(page.getByTestId('first-run')).toHaveCount(0);
    await expect(page.getByTestId('identity-name')).toContainText('Ada');
    const peopleAfterDone = await (await page.request.get('/api/people?stats=0')).json() as { people: Array<{ displayName: string; isMe?: boolean }> };
    expect(peopleAfterDone.people.find((person) => person.isMe)?.displayName).toBe('Ada Topics');
  });

  test('skip persists across reload', async ({ page }) => {
    await page.goto('/');
    await clearFirstRun(page);
    await page.getByTestId('first-run-skip').click();
    await expect(page.getByTestId('first-run')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('first-run')).toHaveCount(0);
  });

  test('shows agent detection, declared model, and optional remote access', async ({ page }) => {
    await page.route('**/api/system/agents', (route) => route.fulfill({ json: { agents: [
      { id: 'claude', name: 'Claude Code', path: '/opt/claude', installed: true, install: 'npm i -g claude', url: '', manualPath: null, manualPathBroken: false, bin: 'claude' },
      { id: 'codex', name: 'Codex', path: null, installed: false, install: 'npm i -g @openai/codex', url: '', manualPath: null, manualPathBroken: false, bin: 'codex' },
    ] } }));
    await page.route('**/api/providers/snapshot', (route) => route.fulfill({ json: {
      providers: [{ name: 'topics', label: 'Topics', status: 'ready', isDefault: true, models: ['claude-opus-5'], defaultModel: 'claude-opus-5', requirements: [], fetchedAt: new Date().toISOString() }],
      defaultProvider: 'topics', generatedAt: new Date().toISOString(),
    } }));
    await page.goto('/');
    await clearFirstRun(page);
    const screen = page.getByTestId('first-run');
    await expect(screen.getByTestId('first-run-agent-claude')).toContainText('/opt/claude');
    await expect(screen.getByTestId('first-run-agent-codex')).toContainText('npm i -g @openai/codex');
    await expect(screen.getByTestId('first-run-model')).toContainText('claude-opus-5');
    await expect(screen.locator('details')).toHaveJSProperty('open', false);
    await expect(screen.getByText(/Google|GitHub/i)).toHaveCount(0);
  });

  test('an installation already in use does not get the screen', async ({ page }) => {
    test.info().annotations.push({ type: 'spec', description: 'FIRST-RUN-01' });
    await page.goto('/');
    await resetFirstRun(page, 'Ada Topics');
    await expect.poll(async () => (await (await page.request.get('/api/app-settings')).json()).settings?.firstRunDoneAt, {
      message: 'the first run is recorded as done',
    }).toBeTruthy();
    await expect(page.getByTestId('first-run')).toHaveCount(0);
  });

  test('settings can reopen the screen', async ({ page }) => {
    await page.goto('/');
    await clearFirstRun(page);
    await page.getByTestId('first-run-skip').click();
    await expect(page.getByTestId('first-run')).toHaveCount(0);
    await openProfileMenu(page);
    await page.getByTestId('open-first-run-settings').click();
    await expect(page.getByTestId('first-run')).toBeVisible();
  });
});
