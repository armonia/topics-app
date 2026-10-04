/**
 * Adding, testing and removing an endpoint somebody runs themselves, with
 * every request intercepted: no real endpoint, no token, no generation.
 *
 * A saved endpoint is a provider (`direct-<id>`), so it is a card of
 * Providers and keys and its detail removes it (model selector revision
 * 2026-10-04, §5.5): the snapshot here is served from memory over both the
 * HTTP route and the WebSocket push, and a save or a removal pushes it again,
 * as the server does. Which provider the composer offers is not asserted here:
 * that half lives in shared/direct-endpoints-boundaries.test.ts.
 *
 * @covers MP-DIRECT-01
 */
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import type { ProvidersSnapshot, ProviderSnapshotEntry } from '../../shared/types';
import { hermetic } from './fixtures/hermetic';
import { goToApp } from './helpers';
import { openHomePanel } from './helpers/user-menu';

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
  const base = options.providers ?? [nativeEntry()];
  let snapshot: ProvidersSnapshot = { providers: base, defaultProvider: 'topics', generatedAt: new Date().toISOString() } as ProvidersSnapshot;
  const sockets: WebSocketRoute[] = [];
  // What the server does after a save or a removal: the endpoint becomes (or
  // stops being) a provider, and the snapshot is pushed to every window.
  const publish = () => {
    snapshot = {
      ...snapshot,
      generatedAt: new Date().toISOString(),
      providers: [...base, ...saved.map((endpoint) => ({
        name: `direct-${endpoint.id}`, label: endpoint.label, status: 'ready' as const, isDefault: false,
        models: ['qwen38-27b-200k'], capabilities: ['streaming'], requirements: [], fetchedAt: new Date().toISOString(),
      }))],
    };
    for (const socket of sockets) socket.send(JSON.stringify({ type: 'providers:snapshot', snapshot }));
  };
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
    sockets.push(socket);
    const server = socket.connectToServer();
    server.onMessage((message) => socket.send(typeof message === 'string' && message.includes('"providers:snapshot"')
      ? JSON.stringify({ type: 'providers:snapshot', snapshot }) : message));
    socket.onMessage((message) => server.send(message));
  });

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
      publish();
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
    publish();
  });

  return { saved, sentTokens };
}

/** Providers and keys with no chat open: a sheet of its own. */
async function openProviders(page: Page) {
  await page.goto('/');
  const level = await openHomePanel(page, 'providers');
  await expect(level.getByTestId('providers-level')).toBeVisible({ timeout: 15_000 });
}

/** «+ Endpoint» opens the form. */
async function fillEndpoint(page: Page, values: { label: string; url: string; token?: string }) {
  await page.getByTestId('providers-add-endpoint').click();
  await expect(page.getByTestId('direct-endpoint-form')).toBeVisible();
  await expect(page.getByTestId('direct-endpoint-label')).toBeFocused();
  await page.getByTestId('direct-endpoint-label').fill(values.label);
  await page.getByTestId('direct-endpoint-url').fill(values.url);
  if (values.token) await page.getByTestId('direct-endpoint-token').fill(values.token);
}

const endpointCard = (page: Page) => page.getByTestId(`provider-card-direct-${ENDPOINT.id}`);

test.describe('Settings · endpoints you run yourself', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('an endpoint is tested, saved, listed and removed', async ({ page }) => {
    test.info().annotations.push({ type: 'spec', description: 'MP-DIRECT-01' });
    const mock = await mockEndpoints(page);
    await openProviders(page);

    await fillEndpoint(page, { label: 'Local llama', url: ENDPOINT.baseUrl });

    // Test first: the reachable endpoint reports its models without saving.
    await page.getByTestId('direct-endpoint-test').click();
    await expect(page.getByTestId('direct-endpoint-models')).toBeVisible();
    expect(mock.saved).toHaveLength(0);

    // Saved: back on the list, where the endpoint is a card of its own.
    await page.getByTestId('direct-endpoint-save').click();
    await expect(endpointCard(page)).toBeVisible();
    await expect(endpointCard(page)).toContainText('Endpoint · 127.0.0.1:18080 · 1 modello');
    expect(mock.saved).toHaveLength(1);

    // Its detail says where it is, and removes it.
    await endpointCard(page).getByTestId('provider-card-open').click();
    const detail = page.getByTestId(`provider-detail-direct-${ENDPOINT.id}`);
    await expect(detail.getByTestId('provider-detail-endpoint')).toContainText(ENDPOINT.baseUrl);
    await detail.getByTestId('provider-detail-endpoint-remove').click();
    await expect(page.getByTestId('providers-level')).toBeVisible();
    await expect(endpointCard(page)).toHaveCount(0);
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
    await expect(endpointCard(page)).toBeVisible();

    expect(mock.sentTokens).toContain('tok-e2e-secret');
    // The detail says a token is set; the secret itself is nowhere in the DOM.
    await endpointCard(page).getByTestId('provider-card-open').click();
    await expect(page.getByTestId('provider-detail-endpoint')).toContainText('token impostato');
    expect(await page.content()).not.toContain('tok-e2e-secret');
  });
});
