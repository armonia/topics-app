/**
 * @covers KANBAN-63
 */
import { describe, expect, test } from 'bun:test';
import { runningLine, workLine } from './workLine';

const tr = (key: string, vars?: Record<string, string | number>) => `${key}${vars ? JSON.stringify(vars) : ''}`;
const MIN = 60_000;
const weight = { usedTokens: 300_000, windowTokens: 1_000_000, estimated: false, billableTokens: 12_000, cacheReadTokens: 0, costCents: 0 };

describe('workLine', () => {
  test('nothing known, nothing said', () => {
    expect(workLine(tr, { elapsedMs: 5 * MIN })).toBe('');
    expect(workLine(tr, { elapsedMs: 5 * MIN, weight: { ...weight, usedTokens: null, windowTokens: null, billableTokens: 0 } })).toBe('');
  });
  test('countdown only with an estimate, re-estimated once the card runs past it', () => {
    const basis = { departureMs: 30 * MIN, historyMs: [30, 30, 30, 30, 30].map((m) => m * MIN) };
    expect(workLine(tr, { basis, elapsedMs: 10 * MIN })).toBe('board.countdown.left{"time":"eta.min{\\"n\\":20}"}');
    expect(workLine(tr, { basis, elapsedMs: 35 * MIN })).toContain('board.countdown.leftRevised');
    expect(workLine(tr, { basis: null, elapsedMs: 35 * MIN })).toBe('');
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

describe('runningLine', () => {
  test('the first to finish and how many were re-estimated; nothing when no card has an estimate', () => {
    expect(runningLine(tr, { count: 3, soonestLeftMs: 7 * MIN, revised: 1 })).toBe('board.countdown.left{"time":"eta.min{\\"n\\":7}"} · workLine.revised{"n":1}');
    expect(runningLine(tr, { count: 2, soonestLeftMs: null, revised: 0 })).toBe('');
  });
});
