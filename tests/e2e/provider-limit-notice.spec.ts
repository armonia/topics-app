/** @covers USAGE-22 @covers USAGE-21 */
import { expect, test } from '@playwright/test';
import { hermetic } from './fixtures/hermetic';
import { createTopic, deleteTopic, resetPaneStore } from './helpers/api-fixtures';
import { AA_TESTO, contrastOf } from './helpers/contrast';

hermetic(test);

let topicId = '';
test.beforeAll(async ({ request }) => {
  topicId = (await createTopic(request, 'Provider limit preview')).id;
});
test.beforeEach(async ({ request }) => {
  await request.post('/api/test/plan-usage', { data: { clear: true } });
  await resetPaneStore(request, [topicId]);
});
test.afterEach(async ({ request }) => {
  await request.post('/api/test/plan-usage', { data: { clear: true } });
});
test.afterAll(async ({ request }) => {
  await deleteTopic(request, topicId);
});

for (const mobile of [false, true]) {
  for (const theme of ['light', 'dark'] as const) {
    test.describe(`${mobile ? 'phone' : 'desktop'} ${theme}`, () => {
      test.use({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
        hasTouch: mobile,
        isMobile: mobile,
        colorScheme: theme,
      });

      test('readable limit, details, settings and released composer space', async ({ page, request }) => {
        test.setTimeout(60_000);
        const themeResponse = await request.put('/api/ui-state/theme', {
          data: JSON.stringify(theme), headers: { 'Content-Type': 'application/json' },
        });
        expect(themeResponse.ok()).toBe(true);
        await page.goto(`/topic/${topicId}`);
        const input = page.getByTestId('chat-message-input');
        await expect(input).toBeVisible();
        if (mobile) await page.getByRole('treeitem', { name: /Provider limit preview/ }).tap();
        await input.click({ trial: true });
        await expect.poll(() => page.locator('html').evaluate((el) => el.classList.contains('dark'))).toBe(theme === 'dark');

        const resetsAtMs = Date.now() + 3 * 24 * 60 * 60_000;
        await request.post('/api/test/plan-usage', { data: { sevenDay: { utilization: 100, resetsAtMs } } });
        const notice = page.getByTestId('provider-hold-notice');
        const details = page.getByTestId('provider-limit-details');
        await expect(notice).toBeVisible();
        await expect(notice).toHaveCount(1);
        await expect(notice).toContainText('Limite Claude raggiunto');
        const datedReset = await page.evaluate((ms) => new Date(ms).toLocaleString('it-IT', {
          day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
        }), resetsAtMs);
        await expect(notice).toContainText(datedReset);
        await expect(page.getByTestId('plan-usage-notice')).toHaveCount(0);
        const dimensions = await notice.evaluate((el) => ({ height: el.getBoundingClientRect().height, overflow: el.scrollWidth > el.clientWidth }));
        expect(dimensions.height).toBeGreaterThanOrEqual(44);
        expect(dimensions.overflow).toBe(false);
        for (const index of [0, 1]) {
          const reading = await contrastOf(page, '[data-testid="provider-hold-notice"] > span > span', index);
          expect(reading.ratio, JSON.stringify(reading)).toBeGreaterThanOrEqual(AA_TESTO);
        }

        if (mobile) {
          const band = page.getByTestId('mobile-transport-band');
          const nav = page.getByTestId('mobile-chrome-bar');
          await expect(band).toBeVisible();
          await expect(nav).toBeVisible();
          await expect.poll(async () => {
            const [composerBox, bandBox, navBox] = await Promise.all([
              page.getByTestId('composer-card').boundingBox(), band.boundingBox(), nav.boundingBox(),
            ]);
            return !!composerBox && !!bandBox && !!navBox
              && composerBox.y + composerBox.height <= bandBox.y + 1
              && bandBox.y + bandBox.height <= navBox.y + 1;
          }).toBe(true);
        }
        await page.screenshot({ path: test.info().outputPath('notice.png') });

        // Keyboard activation on desktop, the actual touch path on a phone.
        if (mobile) await notice.tap();
        else { await notice.focus(); await page.keyboard.press('Enter'); }
        await expect(details).toBeVisible();
        await expect(details).toContainText('Limite settimanale del piano Claude');
        await expect(details).toContainText('avvio automatico dei task attende il reset');
        await expect(details).toContainText(datedReset);
        // The shared phone sheet animates from below the viewport.
        await expect.poll(async () => {
          const box = await details.boundingBox();
          return box ? box.y + box.height : Infinity;
        }).toBeLessThanOrEqual(page.viewportSize()!.height);
        const detailsBox = (await details.boundingBox())!;
        expect(detailsBox.x).toBeGreaterThanOrEqual(0);
        expect(detailsBox.x + detailsBox.width).toBeLessThanOrEqual(page.viewportSize()!.width);
        expect(detailsBox.y + detailsBox.height).toBeLessThanOrEqual(page.viewportSize()!.height);
        if (mobile) expect(detailsBox.width).toBeGreaterThanOrEqual(370);
        await page.screenshot({ path: test.info().outputPath('details.png') });
        await page.keyboard.press('Escape');
        await expect(details).toHaveCount(0);
        if (!mobile) await expect(notice).toBeFocused();
        await notice.click();
        await expect(details).toBeVisible();
        // Dismiss without activating the page behind the shared scrim.
        if (mobile) await page.touchscreen.tap(380, 70);
        else await page.mouse.click(1270, 70);
        await expect(details).toHaveCount(0);

        if (mobile) {
          await notice.tap();
          // Simulate visualViewport shrink at the shell's 85% keyboard threshold.
          // Status frames received while editing must still update the store.
          await page.evaluate(() => {
            Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: window.innerHeight * 0.8 });
            window.visualViewport!.dispatchEvent(new Event('resize'));
          });
          await expect(details).toHaveCount(0);
          await expect(page.getByTestId('mobile-transport-band')).not.toBeVisible();
          await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--mobile-transport-h'))).toBe('0px');
          await request.post('/api/test/plan-usage', { data: { clear: true } });
          await request.post('/api/test/plan-usage', { data: { fiveHour: { utilization: 100, resetsAtMs } } });
          await page.evaluate(() => {
            Reflect.deleteProperty(window.visualViewport!, 'height');
            window.visualViewport!.dispatchEvent(new Event('resize'));
          });
          await expect(notice).toBeVisible();
          await notice.tap();
          await expect(details).toContainText('Finestra di utilizzo di 5 ore');
        } else await notice.click();

        const defaultBefore = (await (await request.get('/api/providers/snapshot')).json()).defaultProvider;
        await details.getByRole('menuitem', { name: 'Gestisci provider AI' }).click();
        await expect(details).toHaveCount(0);
        await expect(page.getByTestId('ai-providers-settings')).toBeVisible();
        const defaultAfter = (await (await request.get('/api/providers/snapshot')).json()).defaultProvider;
        expect(defaultAfter).toBe(defaultBefore);
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('settings-panel')).toHaveCount(0);

        await notice.click();
        await expect(details).toBeVisible();
        await request.post('/api/test/plan-usage', { data: { clear: true } });
        await expect(notice).toHaveCount(0);
        await expect(details).toHaveCount(0);
        if (mobile) {
          await expect(page.getByTestId('mobile-transport-band')).not.toBeVisible();
          await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--mobile-transport-h'))).toBe('0px');
        }
        await input.fill('Posso continuare a scrivere qui.');
        await expect(input).toHaveValue('Posso continuare a scrivere qui.');
      });
    });
  }
}
