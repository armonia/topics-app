/**
 * THE DURATION OF A RUN NOBODY SAW END.
 *
 * A run lost with the server (`sleep 600`, killed with it and never
 * re-adopted) that left no sign of life after its start closes as `unknown`
 * at its own start: the server has nothing later to go on. The header used to
 * read «0.0s» there, a duration nobody measured; it says the duration is not
 * known. A run that did end somewhere after its start keeps its measured time.
 * @covers CMDRUN-06
 */
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CommandRunBlock } from './CommandRunBlock';
import type { CommandRunInfo } from '../../lib/api';

const START = '2026-10-03T10:00:00.000Z';

function header(run: Partial<CommandRunInfo>): string {
  const html = renderToStaticMarkup(createElement(CommandRunBlock, {
    run: {
      runId: 'r-1', blockKey: 0, command: 'sleep 600', cwd: '/tmp', status: 'unknown', exitCode: null,
      startedAt: START, endedAt: START, output: '', droppedLines: 0, ...run,
    },
    sessionKey: 'topic:x', messageId: 'm-1', onRerun: () => {}, onOpenTerminal: () => {},
  }));
  const m = html.match(/data-testid="command-run-duration">([^<]*)</);
  if (!m) throw new Error('no duration in the header');
  return m[1]!;
}

describe('the duration in a run\'s header', () => {
  test('unknown, ended at its own start: the duration is unknown, not 0.0s', () => {
    // Before the fix: «0.0s».
    expect(header({})).toBe('durata sconosciuta');
  });

  test('unknown, ended at its last sign of life: the measured time', () => {
    expect(header({ endedAt: '2026-10-03T10:07:30.000Z' })).toBe('7m 30s');
  });

  test('a run that ended with a code at its start really took no time', () => {
    expect(header({ status: 'done', exitCode: 0 })).toBe('0.0s');
  });
});
