/**
 * STOP COMES FIRST, AND IT IS AN ORDER, NOT A LAYOUT ACCIDENT.
 *
 * The rail at the end of a tab and of a sidebar row can hold two commands at
 * the same instant: interrupt the turn that is running, and dismiss the surface
 * it runs in. Which one comes first is a decision — you stop, then you decide
 * whether to close — and a decision made inside a JSX tree can only be checked
 * by rendering a whole tab bar. Made here, it is three booleans.
 *
 * @covers CHROME-12
 */
import { describe, test, expect } from 'bun:test';
import { rowCommandSequence } from './rowCommandOrder';

describe('rowCommandSequence', () => {
  test('a running turn puts stop before close', () => {
    expect(rowCommandSequence(true)).toEqual(['stop', 'close']);
  });

  test('nothing running: the rail is what it always was', () => {
    expect(rowCommandSequence(false)).toEqual(['close']);
  });

  test('a surface that cannot be dismissed still offers the stop', () => {
    expect(rowCommandSequence(true, false)).toEqual(['stop']);
  });

  test('no turn and no dismissal is an empty rail, not a stray glyph', () => {
    expect(rowCommandSequence(false, false)).toEqual([]);
  });

  test('close is never the first of two', () => {
    for (const closable of [true, false]) {
      for (const canStop of [true, false]) {
        const seq = rowCommandSequence(canStop, closable);
        const stop = seq.indexOf('stop');
        const close = seq.indexOf('close');
        if (stop !== -1 && close !== -1) expect(stop).toBeLessThan(close);
      }
    }
  });
});
