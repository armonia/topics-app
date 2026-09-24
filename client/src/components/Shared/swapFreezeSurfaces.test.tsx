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
import type { LiveTool } from '../Board/constants';
import type { SwapFreezeView } from '../../state/swapFreeze';

/** The words a person reads without hovering: the markup and its tooltips stripped. */
const visibleText = (html: string): string => html.replace(/<[^>]*>/g, ' ');

const freeze: SwapFreezeView = {
  id: 'tree-1', sessionKey: 'topic:a', topicId: 'a', terminalId: null, taskId: 'task-1',
  command: 'bun batteria.ts', footprintGB: 2.1, pagesReadBackPerS: 33.6, debtGBPerMin: 8.8,
  frozenAt: 1_760_000_000_000, thawBy: 1_760_000_600_000, n: 1,
};

describe('the label says which command, how much, and why', () => {
  test('the full pill says what is paused, why and when it resumes, in plain words', () => {
    const html = renderToStaticMarkup(<SwapFreezeLabel freeze={freeze} />);
    const visible = visibleText(html);
    expect(html).toContain('bun batteria.ts');
    expect(visible).toContain('Comando in pausa');
    expect(visible).toContain('a corto di memoria');
    expect(visible).toContain('Riprende da solo');
    expect(visible, 'the jargon stays in the tooltip').not.toMatch(/swap|pagine/);
    expect(html, 'the weight and the mechanism are still one hover away').toContain('2,1 GB');
    expect(html).toContain('swap');
    expect(html, 'the consequence a red test could be blamed on').toContain('timeout');
    expect(html).toContain('data-testid="swap-freeze-label"');
  });

  test('a test suite is named as a test', () => {
    const html = renderToStaticMarkup(<SwapFreezeLabel freeze={{ ...freeze, command: 'bun run test:e2e' }} />);
    expect(html).toContain('Test in pausa');
  });

  test('the compact form is the glyph and one word, with the sentence in the tooltip', () => {
    const html = renderToStaticMarkup(<SwapFreezeLabel freeze={freeze} variant="compact" />);
    expect(html).not.toContain('data-testid="swap-freeze-label"');
    expect(visibleText(html)).toContain('pausa');
    expect(html).toContain('bun batteria.ts');
    expect(html).toContain('<svg');
  });

  test('the row line says it in words that fit a row', () => {
    const html = renderToStaticMarkup(<SwapFreezeLabel freeze={freeze} variant="line" />);
    expect(visibleText(html)).toContain('In pausa: poca memoria');
  });
});

describe('the live tool line stops with the command', () => {
  // The real `LiveTool`, not a cast: a fixture shaped by hand would keep
  // passing after the field it feeds is renamed.
  const tool: LiveTool = { name: 'Bash', input: 'bun batteria.ts', since: 1_760_000_000_000 };

  test('frozen: it says so instead of counting', () => {
    const html = renderToStaticMarkup(<LiveToolLine tool={tool} frozen />);
    expect(html).toContain('in pausa');
  });

  test('not frozen: the elapsed time is back', () => {
    const html = renderToStaticMarkup(<LiveToolLine tool={tool} />);
    expect(html).not.toContain('in pausa');
  });
});
