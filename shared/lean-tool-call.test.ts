import { describe, expect, test } from 'bun:test';
import { blocksForDisk, leanBlocks, leanToolCall, leanToolCalls, toolCallResultText, toolCallsForDisk } from './lean-tool-call';

describe('leanToolCall', () => {
  test('drops result when detail carries the same string (shell)', () => {
    const tc = { id: 'a', name: 'Bash', result: 'hello\nworld', detail: { type: 'shell', command: 'echo', output: 'hello\nworld' } };
    const lean = leanToolCall(tc) as Record<string, unknown>;
    expect('result' in lean).toBe(false);
    expect(lean.detail).toEqual(tc.detail);
  });

  test('drops result when the copy sits in detail.content too (read)', () => {
    const tc = { id: 'a', name: 'Read', result: 'file body', detail: { type: 'read', filePath: '/x', content: 'file body' } };
    expect('result' in (leanToolCall(tc) as object)).toBe(false);
  });

  test('finds the copy nested one level down (unknown.raw.result)', () => {
    const tc = { id: 'a', name: 'X', result: 'out', detail: { type: 'unknown', raw: { result: 'out' } } };
    expect('result' in (leanToolCall(tc) as object)).toBe(false);
  });

  test('KEEPS result when detail says something else (write: confirmation vs content)', () => {
    const tc = { id: 'a', name: 'Write', result: 'File created successfully at: /x', detail: { type: 'write', filePath: '/x', content: '# title' } };
    expect(leanToolCall(tc)).toBe(tc);
  });

  test('KEEPS result when the copy is only a piece, not the whole thing', () => {
    const tc = { id: 'a', name: 'Bash', result: 'line1\nline2', detail: { type: 'shell', command: 'x', output: 'line1' } };
    expect(leanToolCall(tc)).toBe(tc);
  });

  test('KEEPS result when detail is missing: it is the fallback of the renderer', () => {
    const tc = { id: 'a', name: 'Bash', result: 'out' };
    expect(leanToolCall(tc)).toBe(tc);
  });

  test('does not look past the second level: a copy too far down does not authorise the cut', () => {
    const tc = { id: 'a', name: 'X', result: 'out', detail: { type: 'unknown', raw: { nested: { deep: 'out' } } } };
    expect(leanToolCall(tc)).toBe(tc);
  });

  test('an empty or non-string result is left alone', () => {
    const empty = { result: '', detail: { type: 'shell', output: '' } };
    expect(leanToolCall(empty)).toBe(empty);
    const notAString = { result: 42 as unknown as string, detail: { type: 'shell', output: 42 } };
    expect(leanToolCall(notAString)).toBe(notAString);
  });

  test('same reference when there is nothing to drop', () => {
    const tc = { id: 'a', name: 'Edit', result: 'ok', detail: { type: 'edit', filePath: '/x', unifiedDiff: '@@' } };
    expect(leanToolCall(tc)).toBe(tc);
  });
});

describe('leanToolCalls / leanBlocks', () => {
  test('array left intact by reference when no element changes', () => {
    const calls = [{ id: 'a', result: 'x' }, { id: 'b', detail: { type: 'todo', items: [] } }];
    expect(leanToolCalls(calls)).toBe(calls);
    const blocks = [{ kind: 'text', text: 'hello' }];
    expect(leanBlocks(blocks)).toBe(blocks);
  });

  test('blocks: the nested toolCall gets trimmed, the rest of the block stays', () => {
    const blocks = [
      { kind: 'text', text: 'hello' },
      { kind: 'tool', toolCall: { id: 'a', name: 'Bash', result: 'out', detail: { type: 'shell', command: 'c', output: 'out' } } },
    ];
    const lean = leanBlocks(blocks);
    expect(lean).not.toBe(blocks);
    expect(lean[0]).toBe(blocks[0]);
    expect(lean[1].kind).toBe('tool');
    expect('result' in (lean[1].toolCall as object)).toBe(false);
    expect((lean[1].toolCall as { detail: unknown }).detail).toEqual({ type: 'shell', command: 'c', output: 'out' });
  });

  test('does not mutate the original', () => {
    const tc = { id: 'a', name: 'Bash', result: 'out', detail: { type: 'shell', command: 'c', output: 'out' } };
    const blocks = [{ kind: 'tool', toolCall: tc }];
    leanBlocks(blocks);
    expect(tc.result).toBe('out');
  });
});

describe('toolCallsForDisk / blocksForDisk: la copia non arriva sulla riga', () => {
  const doppia = { id: 'a', name: 'Bash', result: 'out', detail: { type: 'shell', command: 'c', output: 'out' } };
  const propria = { id: 'b', name: 'Write', result: 'scritto', detail: { type: 'write', filePath: '/x', content: 'ciao' } };

  test('la colonna assente resta null, e null non e\' la stringa "null"', () => {
    expect(toolCallsForDisk(undefined)).toBeNull();
    expect(toolCallsForDisk(null)).toBeNull();
    expect(blocksForDisk(undefined)).toBeNull();
    // Un array VUOTO invece si scrive: e' un'informazione, non un'assenza.
    expect(toolCallsForDisk([])).toBe('[]');
  });

  test('il testo duplicato compare UNA volta sola nel JSON scritto', () => {
    const json = toolCallsForDisk([doppia])!;
    expect(json).not.toContain('"result"');
    expect(JSON.parse(json)[0].detail.output).toBe('out');
  });

  test('SENZA PERDITA: un result che non e\' copia arriva intero', () => {
    const json = toolCallsForDisk([propria])!;
    expect(JSON.parse(json)[0].result).toBe('scritto');
    expect(JSON.parse(json)[0].detail.content).toBe('ciao');
  });

  test('dentro i blocchi vale la stessa regola, e il resto del blocco non si muove', () => {
    const blocks = [{ kind: 'text', text: 'ciao' }, { kind: 'tool', toolCall: doppia }];
    const parsed = JSON.parse(blocksForDisk(blocks)!);
    expect(parsed[0]).toEqual({ kind: 'text', text: 'ciao' });
    expect('result' in parsed[1].toolCall).toBe(false);
    expect(parsed[1].toolCall.detail.output).toBe('out');
  });
});

describe('toolCallResultText: dove si va a riprendere il testo', () => {
  test('con result presente si legge quello', () => {
    expect(toolCallResultText({ result: 'grezzo', detail: { output: 'altro' } })).toBe('grezzo');
  });

  test('senza result si legge il campo di testo del detail', () => {
    expect(toolCallResultText({ detail: { type: 'shell', output: 'out' } })).toBe('out');
    expect(toolCallResultText({ detail: { type: 'read', content: 'file' } })).toBe('file');
    expect(toolCallResultText({ detail: { type: 'mcp', result: 'ret' } })).toBe('ret');
  });

  test('quando non c\'e\' ne\' l\'uno ne\' l\'altro torna undefined, non stringa vuota', () => {
    expect(toolCallResultText({ detail: { type: 'read', filePath: '/x' } })).toBeUndefined();
    expect(toolCallResultText({ result: '' })).toBeUndefined();
    expect(toolCallResultText(undefined)).toBeUndefined();
  });
});
