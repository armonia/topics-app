/**
 * The shared pane's console rows belong to a page: landing on another document
 * drops the previous one's, a load-time error of the new page stays.
 *
 * @covers TABSLOT-03
 */
import { describe, expect, test } from 'bun:test';
import {
  appendStreamConsole, keepConsoleOfPage, STREAM_CONSOLE_CAP, tallyConsole, type StreamConsoleEntry,
} from './streamConsole';

let seq = 0;
function row(level: StreamConsoleEntry['level'], page: string): StreamConsoleEntry {
  return { id: ++seq, level, text: `${level} ${seq}`, at: 0, page };
}

const A = 'https://example.com/';
const B = 'https://other.example.org/';

describe('keepConsoleOfPage', () => {
  test('landing on another document drops the rows of the one before', () => {
    const rows = [row('error', A), row('warn', A)];
    const kept = keepConsoleOfPage(rows, B);
    expect(kept).toEqual([]);
    expect(tallyConsole(kept)).toEqual({ errors: 0, warnings: 0 });
  });

  test('an error the new page threw while loading, before its load, stays', () => {
    const early = row('error', B);
    expect(keepConsoleOfPage([row('error', A), early], B)).toEqual([early]);
  });

  test('a fragment is the same page, and nothing leaving returns the same array', () => {
    const rows = [row('error', `${A}#top`)];
    expect(keepConsoleOfPage(rows, `${A}#bottom`)).toBe(rows);
  });
});

describe('appendStreamConsole and tallyConsole', () => {
  test('the tally counts errors and warnings, not plain logs', () => {
    let rows: StreamConsoleEntry[] = [];
    for (const level of ['error', 'warn', 'log', 'error'] as const) rows = appendStreamConsole(rows, row(level, A));
    expect(rows).toHaveLength(4);
    expect(tallyConsole(rows)).toEqual({ errors: 2, warnings: 1 });
  });

  test('past the cap the oldest rows leave', () => {
    let rows: StreamConsoleEntry[] = [];
    for (let i = 0; i < STREAM_CONSOLE_CAP + 3; i++) rows = appendStreamConsole(rows, row('log', A));
    expect(rows).toHaveLength(STREAM_CONSOLE_CAP);
    expect(rows[rows.length - 1].id).toBe(seq);
  });
});
