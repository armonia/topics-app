/**
 * The reasoning translation store: a sentence the server translated replaces
 * that sentence in a row, wherever the row got its text, and nothing else.
 *
 * @covers REASONING-TRANSLATE-01
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { applyReasoningTranslations, rememberReasoningTranslation, resetReasoningTranslations } from './reasoningTranslations';
import { isTranslatableSentence, splitSentences } from '../../../shared/reasoning-sentences';

const ONE = 'First I need to read the failing test and see what it expects.';
const TWO = 'Then I will check the migration file for the new column.';

beforeEach(() => resetReasoningTranslations());

describe('applyReasoningTranslations', () => {
  test('without a translation the text comes back untouched', () => {
    expect(applyReasoningTranslations(`${ONE} ${TWO}`)).toEqual({ text: `${ONE} ${TWO}`, count: 0 });
  });

  test('a translated sentence is swapped in place, the others stay original, whitespace is kept', () => {
    rememberReasoningTranslation(ONE, 'Prima devo leggere il test che fallisce.');
    const out = applyReasoningTranslations(`${ONE}\n\n${TWO}`);
    expect(out.count).toBe(1);
    expect(out.text).toBe(`Prima devo leggere il test che fallisce.\n\n${TWO}`);
  });

  test('a sentence still being written (not yet in the store) stays as it is', () => {
    rememberReasoningTranslation(ONE, 'Prima devo leggere il test.');
    const out = applyReasoningTranslations(`${ONE} Then I will chec`);
    expect(out.text).toBe('Prima devo leggere il test. Then I will chec');
  });

  test('the same pair twice is the same state', () => {
    rememberReasoningTranslation(ONE, 'Prima.');
    rememberReasoningTranslation(ONE, 'Prima.');
    expect(applyReasoningTranslations(ONE)).toEqual({ text: 'Prima.', count: 1 });
  });
});

describe('the sentence cut both sides share', () => {
  test('joining the segments gives the text back', () => {
    const text = `${ONE}\n\n${TWO} And a last one without a full stop`;
    expect(splitSentences(text).join('')).toBe(text);
  });

  test('a lone path, a number or a very short word is not worth translating', () => {
    for (const s of ['src/server/db.ts', '42', 'ok.', 'Dr.']) expect(isTranslatableSentence(s)).toBe(false);
    expect(isTranslatableSentence(ONE)).toBe(true);
  });
});
