/**
 * THE PAUSE CARD SPEAKS IN SHARES OF THE MAC, AND OFFERS TO KEEP THE PAGE.
 *
 * Reported on 23/09: the card read «usa il 37% di un core», a unit nobody keeps
 * in mind, and a page costs memory as well as CPU. And there was no way to say
 * «this one, leave it running». Mounted with `renderToStaticMarkup` (no DOM
 * library in this project, see `ThreadRuns.test.tsx`).
 *
 * @covers BROWSER-HEAVY-02
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PausedPane } from './PausedPane';
import { pausedUsageText } from './pausedUsage';
import { t } from '../../lib/i18n';

const tr = (key: string, vars?: Record<string, string | number>) => t(key, 'it', vars);

describe('the pause card', () => {
  test('CPU and memory as shares of the whole machine, never «of a core»', () => {
    const text = pausedUsageText(tr, { cpu: 37, memMb: 1_638.4 }, { cores: 12, memMb: 32_768 });
    expect(text).toContain('3% della CPU');
    expect(text).toContain('5% della memoria del Mac');
    expect(text).not.toContain('core');
  });

  test('without the RAM of the Mac it says the CPU share alone', () => {
    const text = pausedUsageText(tr, { cpu: 37, memMb: 1_024 }, { cores: 12, memMb: null });
    expect(text).toContain('3% della CPU del Mac');
    expect(text).not.toContain('memoria');
  });

  test('the two «keep» choices are offered when the pane can honour them', () => {
    const html = renderToStaticMarkup(
      <PausedPane cpu={37} hasStill={false} onResume={() => {}} onKeepOnce={() => {}} onKeepAlways={() => {}} />,
    );
    expect(html).toContain('data-testid="browser-paused-resume"');
    expect(html).toContain('data-testid="browser-paused-keep-once"');
    expect(html).toContain('data-testid="browser-paused-keep-always"');
  });
});
