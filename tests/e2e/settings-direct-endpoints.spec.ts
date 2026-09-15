/**
 * Adding, testing and removing an endpoint somebody runs themselves, with
 * every request intercepted: no real endpoint, no token, no generation.
 *
 * Which provider the composer offers is NOT asserted here: the page hydrates
 * its snapshot from the live WebSocket as well as from HTTP, so a stubbed
 * /providers/snapshot gets overwritten and the row appears only when the
 * ordering happens to favour it. That half lives in
 * shared/direct-endpoints-boundaries.test.ts, where the rule is a pure
 * function and can actually break.
 *
 * @covers MP-DIRECT-01
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

function nativeEntry(): ProviderSnapshotEntry {
  return {
    name: 'topics',
    label: 'Topics',
    status: 'ready',
    models: ['claude-opus-4-8'],
    defaultModel: 'claude-opus-4-8',
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
    providers: options.providers ?? [nativeEntry()],
    defaultProvider: 'topics',
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
