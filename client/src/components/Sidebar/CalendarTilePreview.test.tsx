import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CalendarTilePreview } from './CalendarTilePreview';

/**
 * @covers CAL-04
 *
 * Static-markup coverage of `CalendarTilePreview`'s render states (card
 * 25775e23). The interactive hover/focus/touch/click behaviour that MOUNTS
 * this component lives in the Playwright specs
 * `tests/e2e/pinned-calendar-tile-preview*.spec.ts` -- this file only
 * proves the component itself renders the right branch for each input,
 * without a DOM (this repo has no jsdom/happy-dom).
 */
describe('CalendarTilePreview', () => {
  test('with no live session it tells the user to open the tab, no request built', () => {
    const html = renderToStaticMarkup(<CalendarTilePreview browserId="ctx-1" active={false} />);
    // No DOM/window here, so `useT` falls back to its Italian default (see
    // `useLocale`'s own comment on that) -- the interesting assertion is
    // that NOTHING gets fetched, not which language answers.
    expect(html).toContain('Apri la tab per vederne l');
    expect(html).not.toContain('<img');
  });

  test('with a live session (non-Tauri) it points an <img> at the snapshot route for that pane', () => {
    const html = renderToStaticMarkup(<CalendarTilePreview browserId="ctx-abc" active={true} />);
    expect(html).toContain('calendar-tile-preview-image');
    expect(html).toContain('/api/browsers/ctx-abc/snapshot');
  });
});
