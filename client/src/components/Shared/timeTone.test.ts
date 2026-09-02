/**
 * THE TWO NUMBERS MUST NOT LOOK ALIKE.
 *
 * A row and a tab can show "12m" for two opposite facts: a turn that has been
 * running for twelve minutes, and a turn that answered twelve minutes ago. The
 * card that asked for this said it in one line: the time of the session has to
 * be told apart from the time it answered. So the running one is the only one
 * that takes the loader's class, and the check that matters is that the three
 * voices never collapse into the same treatment.
 *
 * @covers CHAT-WAIT-02
 */
import { describe, test, expect } from 'bun:test';
import { timeToneClass, timeVoice } from './timeTone';

describe('timeVoice', () => {
  test('working wins over everything else', () => {
    expect(timeVoice(true, false)).toBe('live');
    expect(timeVoice(true, true)).toBe('live');
  });

  test('parked on a question is its own voice, not a receipt', () => {
    expect(timeVoice(false, true)).toBe('waiting');
  });

  test('finished is a receipt', () => {
    expect(timeVoice(false, false)).toBe('past');
  });
});

describe('timeToneClass', () => {
  test('the live number wears the loader class, and only it', () => {
    expect(timeToneClass('live')).toBe('time-live');
    expect(timeToneClass('waiting')).not.toBe('time-live');
    expect(timeToneClass('past')).toBeNull();
  });

  test('the waiting number is amber in both themes', () => {
    const cls = timeToneClass('waiting') ?? '';
    expect(cls).toContain('amber');
    expect(cls).toContain('dark:');
  });

  test('three voices, three distinct treatments', () => {
    const tones = (['live', 'waiting', 'past'] as const).map((v) => timeToneClass(v));
    expect(new Set(tones).size).toBe(3);
  });

  test('on an attention fill the surface keeps its own white', () => {
    for (const v of ['live', 'waiting', 'past'] as const) {
      expect(timeToneClass(v, true)).toBeNull();
    }
  });
});
