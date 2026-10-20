import { test, expect, type Locator } from '@playwright/test';
import { goToApp } from './helpers';
import { resetPaneStore } from './helpers/api-fixtures';
import { E2E_BASE } from './helpers/test-server';
import { hostNativePage } from './helpers/native-host-page';
import { hermetic } from './fixtures/hermetic';

hermetic(test);

/** @covers NATIVE-HOST-09 */
test('cross-origin rrweb frames are labeled and do not relay input', async ({ page, context, request }) => {
  test.info().annotations.push({ type: 'spec', description: 'NATIVE-HOST-09' });
  const contextId = `e2e-cross-frame-${Date.now()}`;
  const hostPage = await context.newPage();
  const pageUrl = `${E2E_BASE}/api/version`;
  const pageOrigin = new URL(pageUrl).origin;
  const otherOrigin = `${pageOrigin.includes('localhost') ? '127.0.0.1' : 'localhost'}:${new URL(pageUrl).port}`;
  const html = `<!doctype html><html><body style="margin:0"><p>Frames</p>
    <iframe id="same-origin" title="same" src="${pageOrigin}/api/version" style="width:300px;height:160px"></iframe>
    <iframe id="cross-origin" title="payment" src="http://${otherOrigin}/api/version?token=private" style="width:300px;height:160px"></iframe>
    <iframe title="hidden tracker" src="http://${otherOrigin}/api/version?hidden" style="display:none"></iframe>
    <iframe title="pixel" src="http://${otherOrigin}/api/version?pixel" style="width:1px;height:1px;border:0"></iframe>
    <div style="height:1600px"></div>
  </body></html>`;
  const host = await hostNativePage(hostPage, contextId, html, {
    size: { width: 800, height: 600 }, title: 'Cross-origin frames', url: pageUrl,
  });
  try {
    await resetPaneStore(request, [`browser:${contextId}`]);
    await goToApp(page);
    const dom = page.locator('[data-testid="browser-dom-cobrowse"]').first();
    const sameFrame = dom.frameLocator('iframe').locator('#same-origin');
    await expect(sameFrame).toBeVisible();
    const placeholder = dom.getByTestId('browser-cross-origin-frame');
    await expect(placeholder).toHaveCount(1);
    await expect(placeholder).toContainText(`Contenuto di ${otherOrigin}`);
    await expect(placeholder).toContainText('Si usa sul Mac');
    await expect(placeholder).not.toContainText('token=private');

    await placeholder.click();
    await expect(dom.getByTestId('browser-cross-origin-notice')).toContainText(`Contenuto di ${otherOrigin}`);
    expect(host.inputs().clicks).toBe(0);

    const overlay = dom.getByTestId('browser-dom-input-overlay');
    await overlay.click({ position: { x: 700, y: 500 } });
    await expect.poll(() => host.inputs().clicks, { timeout: 5_000 }).toBe(1);

    // A new full snapshot rebuilds the mirror with doc.open(), which drops the
    // listeners inside it: after that the label still follows the Mac's scroll.
    await hostPage.evaluate(() => {
      (window as unknown as { __topicsDomHost: { rrweb: { record: { takeFullSnapshot: (isCheckout: boolean) => void } } } })
        .__topicsDomHost.rrweb.record.takeFullSnapshot(true);
    });
    await expect(placeholder).toHaveCount(1);
    // Il rebuild del mirror riattacca gli iframe: finché non sono di nuovo visibili
    // boundingBox() è null e la misura «prima» diventa NaN.
    await expect(sameFrame).toBeVisible();
    await expect(placeholder).toBeVisible();
    const top = async (target: Locator) => (await target.boundingBox())?.y ?? Number.NaN;
    const frameBefore = await top(sameFrame);
    const labelBefore = await top(placeholder);
    await hostPage.evaluate(() => window.scrollTo({ top: 120, behavior: 'instant' as ScrollBehavior }));
    await expect.poll(() => top(sameFrame), { timeout: 5_000 }).toBeLessThan(frameBefore - 20);
    await expect.poll(() => top(placeholder), { timeout: 5_000 }).toBeLessThan(labelBefore - 20);
  } finally {
    host.close();
    await hostPage.close();
  }
});
