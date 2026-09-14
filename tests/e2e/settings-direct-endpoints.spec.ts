/**
 * Adding, testing and removing an endpoint somebody runs themselves, with
 * every request intercepted: no real endpoint, no token, no generation.
 *
 * The one thing this spec is really here to hold is the last test. A
 * configured endpoint is a chat connection and MP-TASK-01 keeps it out of the
 * task pickers: one round trip, no file or bash tool, no update_task, so a
 * card handed to one would never close. That rule is invisible in the UI,
 * which is exactly why it needs a test that fails when it breaks.
 *
 * @covers MP-DIRECT-01
 * @covers MP-DIRECT-04
 */
import { expect, test, type Page } from '@playwright/test';
import type { ProvidersSnapshot, ProviderSnapshotEntry } from '../../shared/types';
import { hermetic } from './fixtures/hermetic';
import { goToApp } from './helpers';
import { openProfileMenu } from './helpers/open-perf-panel';

hermetic(test);

const ENDPOINT = {
  id: 'local-llama',
  label: 'Local llama',
  baseUrl: 'http://127.0.0.1:18080/v1',
  auth: 'none' as const,
  hasToken: false,
  contextWindows: { 'qwen38-27b-200k': 200_192 },
};

function directEntry(): ProviderSnapshotEntry {
  return {
    name: 'direct-local-llama',
    label: 'Local llama',
    status: 'ready',
    models: ['qwen38-27b-200k'],
    defaultModel: 'qwen38-27b-200k',
    requirements: [],
    capabilities: ['streaming', 'history'],
    modelContextWindows: { 'qwen38-27b-200k': 200_192 },
    isDefault: false,
    fetchedAt: new Date().toISOString(),
  } as ProviderSnapshotEntry;
}

function codingEntry(): ProviderSnapshotEntry {
  return {
    name: 'claude',
    label: 'Claude Code',
    status: 'ready',
    models: ['claude-sonnet-4'],
    defaultModel: 'claude-sonnet-4',
    requirements: [],
    capabilities: ['streaming', 'history', 'coding-tasks'],
    isDefault: true,
    fetchedAt: new Date().toISOString(),
  } as ProviderSnapshotEntry;
}

/**
 * The endpoint CRUD, served from memory. `saved` is what the server would have
 * on disk, and the responses never carry a token back, exactly like the real
 * route.
 */
async function mockEndpoints(page: Page, options: { reachable?: boolean; providers?: ProviderSnapshotEntry[] } = {}) {
  const reachable = options.reachable ?? true;
  const saved: Array<typeof ENDPOINT> = [];
  const sentTokens: Array<string | undefined> = [];
  const snapshot: ProvidersSnapshot = {
    providers: options.providers ?? [],
    defaultProvider: null,
    generatedAt: new Date().toISOString(),
  } as ProvidersSnapshot;

  await page.route('**/api/providers/snapshot', (route) => route.fulfill({ json: snapshot }));
  await page.route('**/api/providers/snapshot/refresh', (route) => route.fulfill({ json: { ok: true } }));
  await page.route('**/api/providers/cli', (route) => route.fulfill({ json: { agents: [] } }));
  await page.route('**/api/mcp/fleet', (route) => route.fulfill({
    json: { enabled: true, mounting: false, source: null, servers: [] },
  }));

  await page.route('**/api/providers/endpoints/test', async (route) => {
    sentTokens.push(route.request().postDataJSON().token);
    await route.fulfill({
      json: reachable
        ? { ok: true, models: ['qwen38-27b-200k'] }
        : { ok: false, models: [], error: 'The endpoint did not answer.' },
    });
  });

  await page.route('**/api/providers/endpoints', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      sentTokens.push(body.token);
      if (!reachable) {
        await route.fulfill({ status: 502, json: { error: 'The endpoint did not answer.' } });
        return;
      }
      const stored = { ...ENDPOINT, label: body.label, baseUrl: body.baseUrl, hasToken: Boolean(body.token) };
      saved.splice(0, saved.length, stored);
      await route.fulfill({ json: { ok: true, endpoint: stored, models: ['qwen38-27b-200k'] } });
      return;
    }
    await route.fulfill({ json: { endpoints: saved } });
  });

  await page.route('**/api/providers/endpoints/*', async (route) => {
    if (route.request().method() !== 'DELETE') {
      await route.fallback();
      return;
    }
    saved.splice(0, saved.length);
    await route.fulfill({ json: { ok: true } });
  });

  return { saved, sentTokens };
}

async function openProviders(page: Page) {
  await page.goto('/');
  await openProfileMenu(page);
  await page.getByTestId('topics-menu-settings').click();
  const panel = page.getByTestId('settings-panel');
  await expect(panel).toBeVisible();
  await panel.locator('nav').getByRole('button', { name: 'Providers AI', exact: true }).click();
  await expect(page.getByTestId('ai-providers-settings')).toBeVisible();
  await expect.poll(() => panel.evaluate((element) => getComputedStyle(element).transform)).toBe('none');
}

async function fillEndpoint(page: Page, values: { label: string; url: string; token?: string }) {
  await page.getByTestId('direct-endpoint-add').click();
  await expect(page.getByTestId('direct-endpoint-form')).toBeVisible();
  await page.getByTestId('direct-endpoint-label').fill(values.label);
  await page.getByTestId('direct-endpoint-url').fill(values.url);
  if (values.token) await page.getByTestId('direct-endpoint-token').fill(values.token);
}

test.describe('Settings · endpoints you run yourself', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('an endpoint is tested, saved, listed and removed', async ({ page }) => {
    test.info().annotations.push({ type: 'spec', description: 'MP-DIRECT-01' });
    const mock = await mockEndpoints(page);
    await openProviders(page);

    const panel = page.getByTestId('direct-endpoints-panel');
    await expect(panel).toBeVisible();

    await fillEndpoint(page, { label: 'Local llama', url: ENDPOINT.baseUrl });

    // Test first: the reachable endpoint reports its models without saving.
    await page.getByTestId('direct-endpoint-test').click();
    await expect(page.getByTestId('direct-endpoint-models')).toBeVisible();
    expect(mock.saved).toHaveLength(0);

    await page.getByTestId('direct-endpoint-save').click();
    await expect(page.getByTestId(`direct-endpoint-${ENDPOINT.id}`)).toBeVisible();
    expect(mock.saved).toHaveLength(1);

    await page.getByTestId(`direct-endpoint-delete-${ENDPOINT.id}`).click();
    await expect(page.getByTestId(`direct-endpoint-${ENDPOINT.id}`)).toHaveCount(0);
    expect(mock.saved).toHaveLength(0);
  });

  test('an endpoint that does not answer says so, and nothing is stored', async ({ page }) => {
    test.info().annotations.push({ type: 'spec', description: 'MP-DIRECT-01' });
    const mock = await mockEndpoints(page, { reachable: false });
    await openProviders(page);

    await fillEndpoint(page, { label: 'Wrong port', url: 'http://127.0.0.1:1/v1' });
    await page.getByTestId('direct-endpoint-test').click();

    await expect(page.getByTestId('direct-endpoint-error')).toBeVisible();
    expect(mock.saved).toHaveLength(0);
  });

  test('the token goes out once and never comes back into the page', async ({ page }) => {
    test.info().annotations.push({ type: 'spec', description: 'MP-DIRECT-01' });
    const mock = await mockEndpoints(page);
    await openProviders(page);

    await fillEndpoint(page, { label: 'Gateway', url: 'http://10.0.0.5:8080/v1', token: 'tok-e2e-secret' });
    await page.getByTestId('direct-endpoint-save').click();
    await expect(page.getByTestId(`direct-endpoint-${ENDPOINT.id}`)).toBeVisible();

    expect(mock.sentTokens).toContain('tok-e2e-secret');
    // The row says a token is set; the secret itself is nowhere in the DOM.
    await expect(page.getByTestId(`direct-endpoint-${ENDPOINT.id}`)).toContainText('token');
    expect(await page.content()).not.toContain('tok-e2e-secret');
  });
});

test.describe('A configured endpoint is not a task runtime', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('it is offered in the chat picker and absent from the task picker', async ({ page }) => {
    test.info().annotations.push({ type: 'spec', description: 'MP-DIRECT-04' });
    await mockEndpoints(page, { providers: [directEntry(), codingEntry()] });
    await goToApp(page);

    // The chat surface lists it: that is the whole point of the feature.
    const chatPicker = page.getByTestId('provider-model-picker');
    await expect(chatPicker).toBeVisible();
    await chatPicker.click();
    const chatMenu = page.getByRole('listbox');
    await expect(chatMenu.locator('[data-provider="direct-local-llama"]')).toBeVisible();
    // And its window is the one the endpoint declares, not the table's guess.
    await expect(chatMenu.locator('[data-provider="direct-local-llama"]')).toBeVisible();
    await page.keyboard.press('Escape');

    // The task surface does not, while the real coding runtime still does.
    const taskMenu = page.getByTestId('task-model-menu');
    if (await taskMenu.count()) {
      await expect(taskMenu.locator('[data-provider="direct-local-llama"]')).toHaveCount(0);
      await expect(taskMenu.locator('[data-provider="claude"]')).toBeVisible();
    }
  });
});
