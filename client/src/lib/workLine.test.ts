/**
 * @covers KANBAN-63
 */
import { describe, expect, test } from 'bun:test';
import { workLine } from './workLine';

const tr = (key: string, vars?: Record<string, string | number>) => `${key}${vars ? JSON.stringify(vars) : ''}`;
const MIN = 60_000;
const weight = { usedTokens: 300_000, windowTokens: 1_000_000, estimated: false, billableTokens: 12_000, cacheReadTokens: 0, costCents: 0 };

describe('workLine', () => {
  test('nothing known, nothing said', () => {
    expect(workLine(tr, { elapsedMs: 5 * MIN })).toBe('');
    expect(workLine(tr, { elapsedMs: 5 * MIN, weight: { ...weight, usedTokens: null, windowTokens: null, billableTokens: 0 } })).toBe('');
  });
  test('countdown only with an estimate, in whole minutes', () => {
    expect(workLine(tr, { estimateMs: 30 * MIN, elapsedMs: 10 * MIN })).toBe('board.countdown.left{"min":20}');
    expect(workLine(tr, { estimateMs: 10 * MIN, elapsedMs: 25 * MIN })).toBe('board.countdown.over{"min":15}');
  });
  test('context needs the provider measure, tokens only what was spent', () => {
    const line = workLine(tr, { elapsedMs: 0, weight });
    expect(line).toContain('workLine.context{"approx":"","pct":30');
    expect(line).toContain('workLine.tokens');
    const spentOnly = workLine(tr, { elapsedMs: 0, weight: { ...weight, usedTokens: null, windowTokens: null } });
    expect(spentOnly).not.toContain('workLine.context');
    expect(spentOnly).toContain('workLine.tokens');
  });
  test('an estimated window is marked', () => {
    expect(workLine(tr, { elapsedMs: 0, weight: { ...weight, estimated: true } })).toContain('"approx":"≈ "');
  });
});
