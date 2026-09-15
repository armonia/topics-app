/**
 * THE TWO THINGS THE FROST HAS TO SAY IN WORDS.
 *
 * The label names the command, its weight and the reason, so a frosted card is
 * not a mystery; and the live tool line STOPS ticking, because a stopwatch
 * running over a process Topics has stopped claims progress that is not
 * happening (and repaints once a second on the machine the freeze just relieved).
 *
 * `renderToStaticMarkup`, like `TopicsLoadDot.test.tsx`: jsdom and happy-dom are
 * not dependencies of this project, and what is asserted here is markup.
 *
 * @covers KANBAN-85
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SwapFreezeLabel } from './SwapFreezeLabel';
import { LiveToolLine } from '../Board/CardLive';
import type { SwapFreezeView } from '../../state/swapFreeze';

const freeze: SwapFreezeView = {
  id: 'tree-1', sessionKey: 'topic:a', topicId: 'a', terminalId: null, taskId: 'task-1',
  command: 'bun batteria.ts', footprintGB: 2.1, pagesReadBackPerS: 33.6, debtGBPerMin: 8.8,
  frozenAt: 1_760_000_000_000, thawBy: 1_760_000_600_000, n: 1,
};

describe('the label says which command, how much, and why', () => {
  test('the full pill carries command, weight and the reason in its tooltip', () => {
    const html = renderToStaticMarkup(<SwapFreezeLabel freeze={freeze} />);
    expect(html).toContain('bun batteria.ts');
    expect(html).toContain('2,1 GB');
    expect(html).toContain('swap');
    expect(html, 'the consequence a red test could be blamed on').toContain('timeout');
    expect(html).toContain('data-testid="swap-freeze-label"');
  });

  test('the compact form is the glyph alone, with the same words in the tooltip', () => {
    const html = renderToStaticMarkup(<SwapFreezeLabel freeze={freeze} compact />);
    expect(html).not.toContain('data-testid="swap-freeze-label"');
    expect(html).toContain('bun batteria.ts');
    expect(html).toContain('<svg');
  });
});

describe('the live tool line stops with the command', () => {
  const tool = { name: 'Bash', detail: 'bun batteria.ts', since: 1_760_000_000_000 } as Parameters<typeof LiveToolLine>[0]['tool'];

  test('frozen: it says so instead of counting', () => {
    const html = renderToStaticMarkup(<LiveToolLine tool={tool} frozen />);
    expect(html).toContain('congelato');
  });

  test('not frozen: the elapsed time is back', () => {
    const html = renderToStaticMarkup(<LiveToolLine tool={tool} />);
    expect(html).not.toContain('congelato');
  });
});
