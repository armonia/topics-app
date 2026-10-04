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
import { openHomePanel } from './helpers/user-menu';

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

/** Providers and keys with no chat open: a sheet of its own (from the bottom
 *  on the phone), on the list level. */
async function openProviders(page: Page) {
  await page.goto('/');
  const sheet = page.getByTestId('home-panel-providers');
  await openHomePanel(page, 'providers');
  await expect(sheet.getByTestId('providers-level')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => sheet.evaluate((element) => getComputedStyle(element).transform)).toBe('none');
  return sheet;
}

/** From one form to the other: Escape closes the sheet, and the other opens
 *  on its own. */
async function switchLevel(page: Page, from: 'providers' | 'tools', to: 'providers' | 'tools') {
  await page.keyboard.press('Escape');
  await expect(page.getByTestId(`home-panel-${from}`)).toHaveCount(0);
  return openHomePanel(page, to);
}

/** Opens a card's detail from the list. */
async function openCard(page: Page, name: string) {
  await page.getByTestId(`provider-card-${name}`).getByTestId('provider-card-open').click();
  const detail = page.getByTestId(`provider-detail-${name}`);
  await expect(detail).toBeVisible();
  return detail;
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
        // One panel (MSEL-02): the row names its engine, no engine level to open.
        await page.getByTestId('provider-model-popover').locator('[data-testid="model-row"][data-model="gpt-test"][data-provider="openai"]').click();
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
      await expect(page.getByTestId('provider-default-missing')).toHaveCount(0);
      expect(fixture.fleetReads()).toBe(0);
      await expect(page.getByTestId('provider-card-codex')).toBeVisible();
      // "+ API key": the keys Topics can use and does not have yet.
      for (const provider of ['openai', 'claude'] as ApiProvider[]) {
        await page.getByTestId('providers-add-key').click();
        const level = page.getByTestId('providers-add-key-level');
        await expect(level).toContainText('senza installare una CLI');
        await expect(level.getByTestId('api-billing-note')).toContainText('abbonamenti ChatGPT e Claude sono separati');
        const form = level.getByTestId(`api-key-form-${provider}`);
        const input = form.getByLabel(/^Chiave API/);
        await expect(input).toHaveAttribute('type', 'password');
        await expect(input).toHaveValue('');
        await input.fill(`  fake-${provider}-test-key  `);
        await form.getByRole('button', { name: 'Verifica e collega', exact: true }).click();
        // Saved: back on the list, with the new card.
        await expect(page.getByTestId(`provider-card-${provider}`)).toBeVisible();
        await expect(level).toHaveCount(0);
      }
      expect(fixture.configured).toEqual([
        { provider: 'openai', apiKey: 'fake-openai-test-key' },
        { provider: 'claude', apiKey: 'fake-claude-test-key' },
      ]);
      // Every key connected: "+ API key" says so instead of an empty form.
      await page.getByTestId('providers-add-key').click();
      await expect(page.getByTestId('providers-add-key-level')).toContainText('già collegate');
      await page.keyboard.press('Escape');
      const detail = await openCard(page, 'openai');
      await expect(detail.getByLabel(/^Sostituisci chiave API/)).not.toBeVisible();
      await detail.locator('summary').click();
      await expect(detail.getByLabel(/^Sostituisci chiave API/)).toHaveValue('');
      await expect(detail).toContainText('Vale dal prossimo turno.');
      await expect(detail.getByTestId('api-billing-note')).toContainText('abbonamenti ChatGPT e Claude sono separati');
      await detail.getByTestId('provider-default-set').click();
      await expect(detail.getByTestId('provider-default-clear')).toHaveText('Togli come predefinito');
      expect(fixture.defaultSelections).toEqual(['openai']);
      expect(fixture.fleetReads()).toBe(0);
      const stored = await page.evaluate(() => JSON.stringify(localStorage));
      expect(stored).not.toContain('fake-openai-test-key');
      expect(stored).not.toContain('fake-claude-test-key');
      await expect(page.getByTestId('ai-providers-settings')).not.toContainText('fake-openai-test-key');
      await page.screenshot({ path: test.info().outputPath('settings.png'), style: '#__e2e_caption__ { display: none !important; }' });
      await beat(page);
    });

    test('an errored provider with an existing key can replace it and recover from a rejected key', async ({ page }) => {
      const fixture = await mockProviders(page, [entry('topics'), entry('openai', 'error')]);
      await openProviders(page);
      // The error is the card's one action: "Retry".
      await expect(page.getByTestId('provider-card-openai').getByTestId('provider-card-action')).toHaveText('Riprova');
      const detail = await openCard(page, 'openai');
      await expect(detail.getByTestId('provider-detail-status')).toContainText('Errore');
      await expect(detail.getByTestId('provider-detail-action')).toContainText('Connection rejected');
      await detail.locator('summary').click();
      const form = detail.getByTestId('api-key-form-openai');
      const input = form.getByLabel(/^Sostituisci chiave API/);
      await expect(input).toHaveAttribute('type', 'password');
      await input.fill('rejected-test-key');
      await input.press('Enter');
      await expect(form.getByRole('alert')).toContainText('Chiave API rifiutata');
      await expect(form.getByRole('button')).toBeEnabled();
      await expect(detail.getByTestId('provider-detail-status')).toContainText('Errore');
      await input.fill('replacement-test-key');
      await form.getByRole('button').click();
      await expect(detail.getByTestId('provider-detail-status')).toContainText('Pronto');
      await expect(input).toHaveValue('');
      await expect(form.getByRole('alert')).toHaveCount(0);
      expect(fixture.configured.map((attempt) => attempt.apiKey)).toEqual(['rejected-test-key', 'replacement-test-key']);
      await didascalia(page, 'Una chiave non valida si può correggere qui');
      await beat(page);
    });

    test('the settings for every chat stay reachable in Topics\' detail, and native availability describes Claude', async ({ page }) => {
      const fixture = await mockProviders(page);
      await openProviders(page);
      const topics = await openCard(page, 'topics');
      const everyChat = topics.getByTestId('provider-detail-every-chat');
      await expect(everyChat.getByRole('combobox', { name: 'Motore degli agenti', exact: true })).toBeVisible();
      await expect(everyChat).toContainText('Checkpoint a ogni turno');
      await expect(page.getByTestId('mcp-fleet-panel')).toHaveCount(0);
      await expect(page.getByTestId('settings-permissions')).toHaveCount(0);
      await expect(page.getByTestId('agent-runtime-unavailable')).toHaveCount(0);
      expect(fixture.fleetReads()).toBe(0);
      fixture.removeNative();
      // The engine went away: its card stays, to connect, with the settings for every chat.
      await expect(page.getByTestId('agent-runtime-unavailable')).toContainText('runtime nativo Claude');
      await expect(page.getByTestId('agent-runtime-unavailable')).not.toContainText('jcode');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('provider-default-missing')).toBeVisible();
      await expect(page.getByTestId('provider-card-topics').getByTestId('provider-card-status')).toHaveText('Da collegare');
      await switchLevel(page, 'providers', 'tools');
      await expect(page.getByTestId('mcp-fleet-empty')).toBeVisible();
      await expect(page.getByTestId('settings-permissions')).toBeVisible();
      expect(fixture.fleetReads()).toBe(1);
      await page.screenshot({ path: test.info().outputPath('tools.png') });
      await switchLevel(page, 'tools', 'providers');
      await expect(page.getByTestId('providers-level')).toBeVisible();
      await expect(page.getByTestId('mcp-fleet-panel')).toHaveCount(0);
    });

    if (device.hasTouch) {
      test('the list and an API detail fit the viewport with accessible touch controls', async ({ page }) => {
        await mockProviders(page, [entry('topics'), entry('openai', 'error')]);
        await openProviders(page);
        const detail = await openCard(page, 'openai');
        await detail.locator('summary').click();
        const section = page.getByTestId('ai-providers-settings');
        const metrics = await section.evaluate((root) => {
          const elements = [root, ...root.querySelectorAll('*')] as HTMLElement[];
          const visible = (element: HTMLElement) => element.getBoundingClientRect().height > 0;
          return {
            coarse: matchMedia('(any-pointer: coarse)').matches,
            overflow: elements.filter(visible).filter((element) => element.scrollWidth > element.clientWidth + 1).map((element) => element.tagName),
            small: elements.filter(visible).filter((element) => element.matches('button, input, summary') && element.getBoundingClientRect().height < 43.9).map((element) => ({ tag: element.tagName, text: element.textContent, height: element.getBoundingClientRect().height })),
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
