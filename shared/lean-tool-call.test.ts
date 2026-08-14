import { describe, expect, test } from 'bun:test';
import { leanBlocks, leanToolCall, leanToolCalls } from './lean-tool-call';

describe('leanToolCall', () => {
  test('toglie result quando detail porta la stessa stringa (shell)', () => {
    const tc = { id: 'a', name: 'Bash', result: 'ciao\nmondo', detail: { type: 'shell', command: 'echo', output: 'ciao\nmondo' } };
    const lean = leanToolCall(tc) as Record<string, unknown>;
    expect('result' in lean).toBe(false);
    expect(lean.detail).toEqual(tc.detail);
  });

  test('toglie result anche quando la copia è in detail.content (read)', () => {
    const tc = { id: 'a', name: 'Read', result: 'file body', detail: { type: 'read', filePath: '/x', content: 'file body' } };
    expect('result' in (leanToolCall(tc) as object)).toBe(false);
  });

  test('trova la copia annidata un livello sotto (unknown.raw.result)', () => {
    const tc = { id: 'a', name: 'X', result: 'out', detail: { type: 'unknown', raw: { result: 'out' } } };
    expect('result' in (leanToolCall(tc) as object)).toBe(false);
  });

  test('TIENE result quando detail dice un altra cosa (write: conferma vs contenuto)', () => {
    const tc = { id: 'a', name: 'Write', result: 'File created successfully at: /x', detail: { type: 'write', filePath: '/x', content: '# titolo' } };
    expect(leanToolCall(tc)).toBe(tc);
  });

  test('TIENE result quando la copia è solo un pezzo, non tutto', () => {
    const tc = { id: 'a', name: 'Bash', result: 'riga1\nriga2', detail: { type: 'shell', command: 'x', output: 'riga1' } };
    expect(leanToolCall(tc)).toBe(tc);
  });

  test('TIENE result quando detail manca — è il ripiego del renderer', () => {
    const tc = { id: 'a', name: 'Bash', result: 'out' };
    expect(leanToolCall(tc)).toBe(tc);
  });

  test('non cerca oltre il secondo livello: una copia troppo in fondo non autorizza il taglio', () => {
    const tc = { id: 'a', name: 'X', result: 'out', detail: { type: 'unknown', raw: { nested: { deep: 'out' } } } };
    expect(leanToolCall(tc)).toBe(tc);
  });

  test('result vuoto o non stringa non si tocca', () => {
    const vuoto = { result: '', detail: { type: 'shell', output: '' } };
    expect(leanToolCall(vuoto)).toBe(vuoto);
    const nonStringa = { result: 42 as unknown as string, detail: { type: 'shell', output: 42 } };
    expect(leanToolCall(nonStringa)).toBe(nonStringa);
  });

  test('stesso riferimento quando non c è niente da togliere', () => {
    const tc = { id: 'a', name: 'Edit', result: 'ok', detail: { type: 'edit', filePath: '/x', unifiedDiff: '@@' } };
    expect(leanToolCall(tc)).toBe(tc);
  });
});

describe('leanToolCalls / leanBlocks', () => {
  test('array intatto per riferimento quando nessun elemento cambia', () => {
    const calls = [{ id: 'a', result: 'x' }, { id: 'b', detail: { type: 'todo', items: [] } }];
    expect(leanToolCalls(calls)).toBe(calls);
    const blocks = [{ kind: 'text', text: 'ciao' }];
    expect(leanBlocks(blocks)).toBe(blocks);
  });

  test('blocchi: la toolCall annidata si alleggerisce, il resto del blocco resta', () => {
    const blocks = [
      { kind: 'text', text: 'ciao' },
      { kind: 'tool', toolCall: { id: 'a', name: 'Bash', result: 'out', detail: { type: 'shell', command: 'c', output: 'out' } } },
    ];
    const lean = leanBlocks(blocks);
    expect(lean).not.toBe(blocks);
    expect(lean[0]).toBe(blocks[0]);
    expect(lean[1].kind).toBe('tool');
    expect('result' in (lean[1].toolCall as object)).toBe(false);
    expect((lean[1].toolCall as { detail: unknown }).detail).toEqual({ type: 'shell', command: 'c', output: 'out' });
  });

  test('non muta l originale', () => {
    const tc = { id: 'a', name: 'Bash', result: 'out', detail: { type: 'shell', command: 'c', output: 'out' } };
    const blocks = [{ kind: 'tool', toolCall: tc }];
    leanBlocks(blocks);
    expect(tc.result).toBe('out');
  });
});
