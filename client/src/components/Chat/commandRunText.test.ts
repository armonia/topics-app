/**
 * WHAT «SEND TO AGENT» PUTS IN THE DRAFT.
 *
 * The command behind a prompt, the outcome on one line, the last 50 lines of
 * the output without escapes, in a fence the output cannot close. Plus the
 * two small readings of a run the block shows: its duration and its folder.
 * @covers CHAT-RUN-04
 */
import { describe, expect, test } from 'bun:test';
import { AGENT_TAIL_LINES, formatRunDuration, runDraftText, shortenHome } from './commandRunText';

const summary = ({ outcome, duration, cwd }: { outcome: string; duration: string; cwd: string }) => `(${outcome}, ${duration}, in ${cwd})`;
const seq = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => String(from + i)).join('\n');

describe('runDraftText', () => {
  test('seq 1 80: the command, the outcome, and lines 31 to 80', () => {
    const text = runDraftText({ command: 'seq 1 80', output: `${seq(1, 80)}\n`, outcome: 'exit 0', duration: '0.1s', cwd: '/Users/me/app' }, summary);
    expect(text).toBe(['```console', '$ seq 1 80', '(exit 0, 0.1s, in ~/app)', seq(31, 80), '```'].join('\n'));
    expect(AGENT_TAIL_LINES).toBe(50);
  });

  test('colours and redraws do not reach the agent', () => {
    const text = runDraftText({ command: 'x', output: '\u001b[31mred\u001b[0m\n10%\r100%\n', outcome: 'exit 1', duration: '1s', cwd: '/tmp' }, summary);
    expect(text).toContain('\nred\n100%\n');
    expect(text).not.toContain('\u001b');
  });

  test('a command of several lines keeps them, as a shell transcript does', () => {
    expect(runDraftText({ command: 'cd app\nbun test', output: '', outcome: 'exit 0', duration: '1s', cwd: '/tmp' }, summary))
      .toContain('$ cd app\n> bun test\n');
  });

  test('backticks in the output cannot close the fence', () => {
    const text = runDraftText({ command: 'cat README.md', output: '````js\nx\n````\n', outcome: 'exit 0', duration: '1s', cwd: '/tmp' }, summary);
    expect(text.startsWith('`````console\n')).toBe(true);
    expect(text.endsWith('\n`````')).toBe(true);
  });
});

describe('formatRunDuration and shortenHome', () => {
  test('durations', () => {
    expect(formatRunDuration(3049)).toBe('3.0s');
    expect(formatRunDuration(42_000)).toBe('42s');
    expect(formatRunDuration(65_000)).toBe('1m 5s');
    expect(formatRunDuration(3_720_000)).toBe('1h 2m');
  });

  test('a home folder is written from ~, anything else as it is', () => {
    expect(shortenHome('/Users/me/Projects/x')).toBe('~/Projects/x');
    expect(shortenHome('/home/me')).toBe('~');
    expect(shortenHome('/tmp/x')).toBe('/tmp/x');
  });
});
