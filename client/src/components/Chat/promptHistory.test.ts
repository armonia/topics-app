/**
 * @covers CHAT-04
 */
import { describe, it, expect } from 'bun:test';
import { IDLE, historyEntries, onArrow, typedText, type ArrowInput } from './promptHistory';

const entries = ['prima', 'seconda\nsu due righe', 'terza'];
const at = (over: Partial<ArrowInput>): ArrowInput => ({
  key: 'ArrowUp', entries, value: '', caretOnFirstLine: true, caretOnLastLine: true, ...over,
});

describe('prompt history in the composer', () => {
  it('↑ in an empty field brings back the newest prompt, then the ones before', () => {
    const a = onArrow(IDLE, at({}));
    expect(a).toEqual({ handled: true, state: { index: 2 }, value: 'terza' });
    const b = onArrow(a.state, at({ value: 'terza' }));
    expect(b.handled && b.value).toBe('seconda\nsu due righe');
  });

  it('↑ in a field with text is the caret\'s, not the history\'s', () => {
    expect(onArrow(IDLE, at({ value: 'sto scrivendo' })).handled).toBe(false);
  });

  it('inside a multi-line entry the arrows move the caret until the edge line', () => {
    const st = { index: 1 };
    const value = entries[1];
    expect(onArrow(st, at({ value, caretOnFirstLine: false })).handled).toBe(false);
    expect(onArrow(st, at({ key: 'ArrowDown', value, caretOnLastLine: false })).handled).toBe(false);
    const up = onArrow(st, at({ value }));
    expect(up.handled && up.value).toBe('prima');
  });

  it('↓ past the newest entry gives the empty field back', () => {
    const r = onArrow({ index: 2 }, at({ key: 'ArrowDown', value: 'terza' }));
    expect(r).toEqual({ handled: true, state: IDLE, value: '' });
  });

  it('an edited entry is text being written: the arrows let go', () => {
    expect(onArrow({ index: 2 }, at({ value: 'terza modificata' })).handled).toBe(false);
    expect(onArrow({ index: 2 }, at({ key: 'ArrowDown', value: 'terza modificata' })).handled).toBe(false);
  });

  it('at the oldest entry ↑ does nothing more', () => {
    expect(onArrow({ index: 0 }, at({ value: 'prima' })).handled).toBe(false);
  });
});

describe('what comes back is what was typed', () => {
  it('drops the wrappers the composer added', () => {
    expect(typedText('[Attached file: /tmp/a.png]\n[Attached file: /tmp/b.png]\nguarda queste')).toBe('guarda queste');
    expect(typedText('[Context files]\n<file path="a">x</file>\n[/Context files]\n\nspiegami a')).toBe('spiegami a');
    expect(typedText('> citazione della risposta\n\nè sbagliato')).toBe('è sbagliato');
  });

  it('collapses consecutive repeats and skips empty prompts', () => {
    expect(historyEntries(['ok', 'ok', ' ', 'ancora', 'ok'])).toEqual(['ok', 'ancora', 'ok']);
  });
});
