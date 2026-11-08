/**
 * The words of the Agents row: one waiting session takes the singular key,
 * and an idle agent is not called with the word for stale cards.
 *
 * @covers TOPIC-02
 */
import { describe, expect, test } from 'bun:test';
import { interpolate } from './i18n';
import { agentsWaitingText } from './agentsWaitingText';
import IT from './i18n-it';
import EN from './i18n-en';

const trOf = (dict: Record<string, string>) => (key: string, vars?: Record<string, string | number>) =>
  interpolate(dict[key] ?? key, vars);

describe('agentsWaitingText', () => {
  test('one waiting session takes the singular', () => {
    expect(agentsWaitingText(1, trOf(IT))).toBe('1 aspetta te');
    expect(agentsWaitingText(1, trOf(EN))).toBe('1 waiting for you');
  });
  test('more than one keeps the plural', () => {
    expect(agentsWaitingText(3, trOf(IT))).toBe('3 aspettano te');
  });
});

describe('agent idle word', () => {
  test('idle is not called «fermo», which already names stale and parked cards', () => {
    expect(IT['agents.state.idle']).toBe('a riposo');
  });
});
