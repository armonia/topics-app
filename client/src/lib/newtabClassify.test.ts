/**
 * The new-tab submit doors: a command attempt stays a suggestion, a long or
 * multiline text offers a note, anything else navigates under the bar's own
 * rule. The edges that matter are the ones that look alike: a local path is
 * not a command, an unknown /name is not a navigation.
 *
 * @covers NEWTAB-ARC-03
 */
import { describe, test, expect } from 'bun:test';
import {
  classifyNewTabSubmit,
  isLongNewTabText,
  matchNewTabCommand,
  slugNewTabNoteName,
  NEWTAB_FILE_LENGTH,
} from './newtabClassify';

const KNOWN = ['/status', '/model', '/resume'];

describe('matchNewTabCommand', () => {
  test('a known name resolves to its canonical /name', () => {
    expect(matchNewTabCommand('/status', KNOWN)).toBe('/status');
    expect(matchNewTabCommand('/model gpt', KNOWN)).toBe('/model');
    expect(matchNewTabCommand('  /resume  ', KNOWN)).toBe('/resume');
  });

  test('matching ignores case and normalises to lowercase', () => {
    expect(matchNewTabCommand('/STATUS', KNOWN)).toBe('/status');
  });

  test('an unknown /name is still a command attempt, not a navigation', () => {
    expect(matchNewTabCommand('/invented', KNOWN)).toBe('/invented');
  });

  test('a local path is not a command, with or without a second slash', () => {
    expect(matchNewTabCommand('/Users/x/doc.pdf', KNOWN)).toBeNull();
    expect(matchNewTabCommand('/file.pdf', KNOWN)).toBeNull();
    expect(matchNewTabCommand('file:///Users/x/doc.pdf', KNOWN)).toBeNull();
  });

  test('a url and prose are not commands', () => {
    expect(matchNewTabCommand('esempio.it', KNOWN)).toBeNull();
    expect(matchNewTabCommand('how to make pasta', KNOWN)).toBeNull();
    expect(matchNewTabCommand('', KNOWN)).toBeNull();
  });
});

describe('isLongNewTabText', () => {
  test('over the threshold, or multiline at any length', () => {
    expect(isLongNewTabText('x'.repeat(NEWTAB_FILE_LENGTH + 1))).toBe(true);
    expect(isLongNewTabText('x'.repeat(NEWTAB_FILE_LENGTH))).toBe(false);
    expect(isLongNewTabText('first\nsecond')).toBe(true);
    expect(isLongNewTabText('short')).toBe(false);
  });
});

describe('classifyNewTabSubmit', () => {
  test('blank submits classify to nothing', () => {
    expect(classifyNewTabSubmit('   ', KNOWN)).toBeNull();
  });

  test('a command attempt wins over length', () => {
    const long = `/status ${'x'.repeat(NEWTAB_FILE_LENGTH + 10)}`;
    expect(classifyNewTabSubmit(long, KNOWN)).toEqual({ kind: 'command', value: '/status' });
  });

  test('a long text offers the note door', () => {
    const text = 'y'.repeat(NEWTAB_FILE_LENGTH + 1);
    expect(classifyNewTabSubmit(text, KNOWN)).toEqual({ kind: 'file', value: text });
    expect(classifyNewTabSubmit('a\nb', KNOWN)?.kind).toBe('file');
  });

  test('anything else navigates under the bar rule', () => {
    expect(classifyNewTabSubmit('esempio.it', KNOWN)).toEqual({ kind: 'url', value: 'https://esempio.it' });
    expect(classifyNewTabSubmit('/Users/x/doc.pdf', KNOWN)?.kind).toBe('url');
  });
});

describe('slugNewTabNoteName', () => {
  test('first line, folded and dashed', () => {
    expect(slugNewTabNoteName('Hello World')).toBe('hello-world');
    expect(slugNewTabNoteName('Città nuova: appunti!\nsecond line')).toBe('citta-nuova-appunti');
  });

  test('caps length and falls back when nothing survives', () => {
    expect(slugNewTabNoteName('a'.repeat(100)).length).toBeLessThanOrEqual(40);
    expect(slugNewTabNoteName('   ')).toBe('nota');
    expect(slugNewTabNoteName('---')).toBe('nota');
  });
});
