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
  test('ONE share of the Mac, the larger of CPU and memory, never «of a core»', () => {
    // 37% of one core on 12 = 3% of the CPU; 1.6 GB of 32 = 5% of the memory.
    const text = pausedUsageText(tr, { cpu: 37, memMb: 1_638.4 }, { cores: 12, memMb: 32_768 });
    expect(text).toBe('Questa pagina usava il 5% del Mac. Riprende da dove era.');
    expect(text).not.toMatch(/core|CPU|memoria/);
  });

  test('without the RAM of the Mac it says the CPU share alone', () => {
    const text = pausedUsageText(tr, { cpu: 37, memMb: 1_024 }, { cores: 12, memMb: null });
    expect(text).toContain('il 3% del Mac');
  });

  test('the Italian article follows the number: «l\u201911%», «l\u201980%»', () => {
    expect(pausedUsageText(tr, { cpu: 132 }, { cores: 12, memMb: null })).toContain("usava l'11% del Mac");
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
