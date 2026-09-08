/**
 * API onboarding and replacement, with every credential/configuration request
 * intercepted. No real key, provider probe or paid generation is used.
 * @covers MP-SETUP-02 @covers MP-SETUP-01 @covers APPSET-01 @covers SETMOB-01 @covers RT-10 @covers SNAPSYNC-01
 */
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import type { ProvidersSnapshot, ProviderSnapshotEntry } from '../../shared/types';
import { hermetic } from './fixtures/hermetic';
import { beat, didascalia } from './helpers/evidence';
import { createTopic, deleteTopic, resetPaneStore } from './helpers/api-fixtures';
import { goToApp, openTopic } from './helpers';
import { mockChatStream } from './helpers/sse-helpers';
import { openProfileMenu } from './helpers/open-perf-panel';

hermetic(test);

type ApiProvider = 'openai' | 'claude';

function entry(name: string, status: ProviderSnapshotEntry['status'] = 'ready'): ProviderSnapshotEntry {
  return {
    name, label: name, status, isDefault: name === 'topics',
    models: name === 'openai' ? ['gpt-test'] : ['claude-test'],
    defaultModel: name === 'openai' ? 'gpt-test' : 'claude-test',
    requirements: name === 'topics' ? [] : [{
      key: name === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY', label: 'API key', present: true,
    }],
    ...(status === 'error' ? { lastError: 'Connection rejected' } : {}),
    fetchedAt: new Date().toISOString(),
  };
}

async function mockProviders(page: Page, providers: ProviderSnapshotEntry[] = [entry('topics')]) {
  let snapshot: ProvidersSnapshot = { providers, defaultProvider: 'topics', generatedAt: new Date().toISOString() };
  const connections: WebSocketRoute[] = [];
  const configured: Array<{ provider: string; apiKey: string }> = [];
  const defaultSelections: string[] = [];
  let fleetReads = 0;
  const settingsResponse = await page.request.get('/api/app-settings');
  expect(settingsResponse.ok()).toBe(true);
  let settings = { ...(await settingsResponse.json()).settings, aiProvider: 'topics', agentRuntime: 'topics' };
  const broadcast = () => {
    snapshot = { ...snapshot, generatedAt: new Date().toISOString() };
    for (const socket of connections) socket.send(JSON.stringify({ type: 'providers:snapshot', snapshot }));
  };
  await page.route('**/api/app-settings', async (route) => {
    if (route.request().method() === 'PUT') settings = { ...settings, ...route.request().postDataJSON() };
    await route.fulfill({ json: { settings } });
  });
  await page.route('**/api/providers/snapshot', (route) => route.fulfill({ json: snapshot }));
  await page.route('**/api/providers/snapshot/refresh', async (route) => {
    broadcast();
    await route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/providers/*/configure', async (route) => {
    const provider = new URL(route.request().url()).pathname.split('/').at(-2)!;
    const body = route.request().postDataJSON();
    configured.push({ provider, apiKey: body.apiKey });
    if (body.apiKey === 'rejected-test-key') {
      await route.fulfill({ status: 400, json: { error: 'Connection rejected. Check the API key.', code: 'api_key_rejected' } });
      return;
    }
    const connected = entry(provider);
    snapshot.providers = [...snapshot.providers.filter((item) => item.name !== provider), connected];
    await route.fulfill({ json: { ok: true, provider: { name: provider } } });
    broadcast();
  });
  await page.route('**/api/providers/default', async (route) => {
    const { provider: name } = route.request().postDataJSON();
    defaultSelections.push(name);
    settings = { ...settings, aiProvider: name };
    snapshot = { ...snapshot, defaultProvider: name, providers: snapshot.providers.map((item) => ({ ...item, isDefault: item.name === name })) };
    await route.fulfill({ json: { ok: true } });
    broadcast();
  });
  await page.route('**/api/mcp/fleet', async (route) => {
    fleetReads++;
    await route.fulfill({ json: { enabled: true, mounting: false, source: null, servers: [] } });
  });
  await page.route('**/api/providers/cli', (route) => route.fulfill({ json: { agents: [] } }));
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
    connections.push(socket);
    const server = socket.connectToServer();
    server.onMessage((message) => {
      if (typeof message === 'string' && message.includes('"providers:snapshot"')) {
        socket.send(JSON.stringify({ type: 'providers:snapshot', snapshot }));
      } else socket.send(message);
    });
    socket.onMessage((message) => server.send(message));
  });
  return {
    configured, defaultSelections, fleetReads: () => fleetReads,
    removeNative: () => { snapshot.providers = snapshot.providers.filter((item) => item.name !== 'topics'); broadcast(); },
  };
}

async function openProviders(page: Page) {
  await page.goto('/');
  await openProfileMenu(page);
  await page.getByTestId('topics-menu-settings').click();
  await page.getByTestId('topics-menu-settings-all').click();
  const panel = page.getByTestId('settings-panel');
  await expect(panel).toBeVisible();
  await panel.locator('nav').getByRole('button', { name: 'Providers AI', exact: true }).click();
  await expect(page.getByTestId('ai-providers-settings')).toBeVisible();
  await expect.poll(() => panel.evaluate((element) => getComputedStyle(element).transform)).toBe('none');
}

for (const device of [
  { name: 'desktop', viewport: { width: 1280, height: 900 }, hasTouch: false, isMobile: false },
  { name: 'mobile', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
]) {
  test.describe(`Settings API providers · ${device.name}`, () => {
    test.use({ viewport: device.viewport, hasTouch: device.hasTouch, isMobile: device.isMobile });

    test('a GPT choice remains selected and reaches the outgoing chat request', async ({ page, request }) => {
      test.info().annotations.push({ type: 'spec', description: 'MP-API-01' });
      const topic = await createTopic(request, `GPT picker ${device.name} ${Date.now()}`);
      try {
        await resetPaneStore(request, [topic.id]);
        await mockProviders(page, [entry('topics'), entry('openai')]);
        await goToApp(page);
        await page.keyboard.press('Escape');
        await openTopic(page, new RegExp(topic.name));
        await mockChatStream(page, { chunks: ['GPT test response'], userMessage: 'GPT selection test' });
        let sent: Record<string, unknown> | null = null;
        await page.route('**/api/chat', async (route) => {
          if (route.request().method() === 'POST') sent = route.request().postDataJSON();
          await route.fallback();
        });
        const picker = page.getByTestId('provider-model-picker');
        await picker.click();
        await page.getByTestId('provider-model-popover').locator('[data-model="gpt-test"]').click();
        await expect(picker).toHaveAttribute('data-model', 'gpt-test');
        const input = page.getByRole('textbox', { name: /Campo del messaggio/ });
        await input.fill('GPT selection test');
        await input.press('Enter');
        await expect.poll(() => sent).toMatchObject({ provider: 'openai', model: 'gpt-test' });
        await beat(page);
      } finally { await deleteTopic(request, topic.id); }
    });

    test('fresh installation connects both API providers and selects the default', async ({ page }) => {
      const fixture = await mockProviders(page, [entry('topics'), entry('codex')]);
      await openProviders(page);
      await didascalia(page, 'GPT e Claude: API per le chat, senza CLI');
      const section = page.getByTestId('ai-providers-settings');
      await expect(section.getByTestId('api-billing-note')).toContainText('abbonamenti ChatGPT e Claude sono separati');
      await expect(page.getByTestId('provider-default-missing')).toHaveCount(0);
      await expect(page.getByTestId('ai-providers-advanced')).toHaveCount(0);
      expect(fixture.fleetReads()).toBe(0);
      await expect(page.getByTestId('provider-card-codex')).toBeVisible();
      for (const provider of ['openai', 'claude'] as ApiProvider[]) {
        const setup = page.getByTestId(`api-provider-setup-${provider}`);
        await expect(setup).toBeVisible();
        await expect(setup.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
        await setup.getByRole('button').click();
        await expect(setup).toContainText('senza installare una CLI');
        const input = setup.getByLabel(/^Chiave API/);
        await expect(input).toHaveAttribute('type', 'password');
        await expect(input).toHaveValue('');
        await input.fill(`  fake-${provider}-test-key  `);
        await setup.getByRole('button', { name: 'Verifica e collega', exact: true }).click();
        const card = page.getByTestId(`provider-card-${provider}`);
        await expect(card).toBeVisible();
        await expect(setup).toHaveCount(0);
        await expect(card.getByRole('button').first()).toHaveAttribute('aria-expanded', 'true');
        await expect(card.getByLabel(/^Sostituisci chiave API/)).not.toBeVisible();
        await card.locator('summary').click();
        await expect(card.getByLabel(/^Sostituisci chiave API/)).toHaveValue('');
        await expect(card).toContainText('Vale dal prossimo turno.');
        await card.getByRole('button').first().click();
      }
      expect(fixture.configured).toEqual([
        { provider: 'openai', apiKey: 'fake-openai-test-key' },
        { provider: 'claude', apiKey: 'fake-claude-test-key' },
      ]);
      const apiCard = page.getByTestId('provider-card-openai');
      await apiCard.getByRole('button').first().click();
      await apiCard.getByRole('button', { name: 'Imposta come predefinito', exact: true }).click();
      await expect(apiCard.getByRole('button', { name: 'Togli il default (scegli automaticamente)', exact: true })).toBeVisible();
      expect(fixture.defaultSelections).toEqual(['openai']);
      expect(fixture.fleetReads()).toBe(0);
      const stored = await page.evaluate(() => JSON.stringify(localStorage));
      expect(stored).not.toContain('fake-openai-test-key');
      expect(stored).not.toContain('fake-claude-test-key');
      await expect(section).not.toContainText('fake-openai-test-key');
      await page.screenshot({ path: test.info().outputPath('settings.png'), style: '#__e2e_caption__ { display: none !important; }' });
      await beat(page);
    });

    test('an errored provider with an existing key can replace it and recover from a rejected key', async ({ page }) => {
      const fixture = await mockProviders(page, [entry('topics'), entry('openai', 'error')]);
      await openProviders(page);
      const card = page.getByTestId('provider-card-openai');
      await card.getByRole('button').first().click();
      const form = card.getByTestId('api-key-form-openai');
      const input = form.getByLabel(/^Sostituisci chiave API/);
      await expect(input).toHaveAttribute('type', 'password');
      await input.fill('rejected-test-key');
      await input.press('Enter');
      await expect(form.getByRole('alert')).toContainText('Chiave API rifiutata');
      await expect(form.getByRole('button')).toBeEnabled();
      await expect(card.getByRole('button').first()).toContainText('Da verificare');
      await input.fill('replacement-test-key');
      await form.getByRole('button').click();
      await expect(card.getByRole('button').first()).toContainText('Connesso');
      await expect(input).not.toBeVisible();
      await card.locator('summary').click();
      await expect(input).toHaveValue('');
      await expect(form.getByRole('alert')).toHaveCount(0);
      expect(fixture.configured.map((attempt) => attempt.apiKey)).toEqual(['rejected-test-key', 'replacement-test-key']);
      await didascalia(page, 'Una chiave non valida si può correggere qui');
      await beat(page);
    });

    test('advanced controls stay reachable and native availability describes Claude', async ({ page }) => {
      const fixture = await mockProviders(page);
      await openProviders(page);
      const toggle = page.getByTestId('ai-providers-advanced-toggle');
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      const advanced = page.getByTestId('ai-providers-advanced');
      await expect(advanced.getByRole('combobox', { name: 'Runtime degli agenti', exact: true })).toBeVisible();
      await expect(advanced.getByTestId('cli-agents-panel')).toBeVisible();
      await expect(page.getByTestId('mcp-fleet-panel')).toHaveCount(0);
      await expect(page.getByTestId('settings-permissions')).toHaveCount(0);
      await expect(page.getByTestId('agent-runtime-unavailable')).toHaveCount(0);
      await expect(page.getByTestId('provider-default-missing')).toHaveCount(0);
      expect(fixture.fleetReads()).toBe(0);
      fixture.removeNative();
      await expect(page.getByTestId('agent-runtime-unavailable')).toContainText('runtime nativo Claude');
      await expect(page.getByTestId('agent-runtime-unavailable')).not.toContainText('jcode');
      await expect(page.getByTestId('provider-default-missing')).toBeVisible();
      await toggle.click();
      await expect(advanced).toHaveCount(0);
      const panel = page.getByTestId('settings-panel');
      await panel.locator('nav').getByRole('button', { name: 'Strumenti', exact: true }).click();
      await expect(page.getByTestId('mcp-fleet-empty')).toBeVisible();
      await expect(page.getByTestId('settings-permissions')).toBeVisible();
      expect(fixture.fleetReads()).toBe(1);
      await page.screenshot({ path: test.info().outputPath('tools.png') });
      await panel.locator('nav').getByRole('button', { name: 'Providers AI', exact: true }).click();
      await expect(page.getByTestId('ai-providers-settings')).toBeVisible();
      await expect(page.getByTestId('mcp-fleet-panel')).toHaveCount(0);
    });

    if (device.hasTouch) {
      test('setup and expanded API cards fit the viewport with accessible touch controls', async ({ page }) => {
        await mockProviders(page, [entry('topics'), entry('openai', 'error')]);
        await openProviders(page);
        await page.getByTestId('provider-card-openai').getByRole('button').first().click();
        const section = page.getByTestId('ai-providers-settings');
        const metrics = await section.evaluate((root) => {
          const elements = [root, ...root.querySelectorAll('*')] as HTMLElement[];
          const visible = (element: HTMLElement) => element.getBoundingClientRect().height > 0;
          return {
            coarse: matchMedia('(any-pointer: coarse)').matches,
            overflow: elements.filter(visible).filter((element) => element.scrollWidth > element.clientWidth + 1).map((element) => element.tagName),
            small: elements.filter(visible).filter((element) => element.matches('button, input') && element.getBoundingClientRect().height < 43.9).map((element) => ({ tag: element.tagName, text: element.textContent, height: element.getBoundingClientRect().height })),
            inputFontSizes: elements.filter(visible).filter((element) => element.matches('input[type="password"]')).map((element) => parseFloat(getComputedStyle(element).fontSize)),
          };
        });
        expect(metrics.coarse).toBe(true);
        expect(metrics.overflow).toEqual([]);
        expect(metrics.small).toEqual([]);
        expect(metrics.inputFontSizes).toHaveLength(1);
        expect(metrics.inputFontSizes.every((size) => size >= 16)).toBe(true);
        await didascalia(page, 'Configurazione API da telefono');
        await beat(page);
      });
    }
  });
}
