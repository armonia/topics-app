/**
 * @covers LEAN-01
 */
import { describe, expect, test } from 'bun:test';
import {
  WIRE_STRING_PREVIEW_CHARS,
  blocksForDisk,
  leanBlocks,
  leanMessagesForHistory,
  leanToolCall,
  leanToolCallForHistory,
  leanToolCalls,
  stripArgsText,
  stripDetailText,
  toolCallResultText,
  toolCallsForDisk,
} from './lean-tool-call';

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

// ── The history wire: previews for the long strings a closed row never reads ─

/** The shape the history wire trims: the counters are what the trim adds. */
type WireCall = {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  argsBytes?: number;
  detail?: Record<string, unknown>;
  detailBytes?: number;
};

/** A string one character over the threshold, and one exactly at it. */
const OVER = 'a'.repeat(WIRE_STRING_PREVIEW_CHARS + 1);
const AT = 'b'.repeat(WIRE_STRING_PREVIEW_CHARS);
/** A 30 KB script: the shape measured on the live DB (a Bash block with 33 KB of `args`). */
const SCRIPT = `echo first line\n${'echo filler line of a long script\n'.repeat(900)}echo LAST`;

describe('stripArgsText: the long strings of args travel as their head', () => {
  test('a string over the threshold is cut to the threshold and the cut is declared', () => {
    const tc: WireCall = { id: 'a', name: 'Bash', args: { command: SCRIPT, description: 'run it' } };
    const lean = stripArgsText(tc);
    expect(lean).not.toBe(tc);
    expect((lean.args as { command: string }).command).toBe(SCRIPT.slice(0, WIRE_STRING_PREVIEW_CHARS));
    expect((lean.args as { command: string }).command.startsWith('echo first line')).toBe(true);
    expect(lean.argsBytes).toBe(SCRIPT.length - WIRE_STRING_PREVIEW_CHARS);
    // The short field next to it is untouched.
    expect((lean.args as { description: string }).description).toBe('run it');
  });

  test('a string AT the threshold travels whole, one character over does not', () => {
    const whole: WireCall = { id: 'a', name: 'X', args: { s: AT } };
    expect(stripArgsText(whole)).toBe(whole);
    const cut = stripArgsText<WireCall>({ id: 'a', name: 'X', args: { s: OVER } });
    expect((cut.args as { s: string }).s.length).toBe(WIRE_STRING_PREVIEW_CHARS);
    expect(cut.argsBytes).toBe(1);
  });

  test('nested: a MultiEdit carries its long strings inside edits[]', () => {
    const tc: WireCall = { id: 'a', name: 'MultiEdit', args: { file_path: '/x.ts', edits: [{ old_string: OVER, new_string: SCRIPT }, { old_string: 'short', new_string: 'short too' }] } };
    const lean = stripArgsText(tc);
    const edits = (lean.args as { edits: Array<{ old_string: string; new_string: string }> }).edits;
    expect(edits[0].old_string.length).toBe(WIRE_STRING_PREVIEW_CHARS);
    expect(edits[0].new_string.length).toBe(WIRE_STRING_PREVIEW_CHARS);
    expect(edits[1]).toEqual({ old_string: 'short', new_string: 'short too' });
    expect(lean.argsBytes).toBe(1 + SCRIPT.length - WIRE_STRING_PREVIEW_CHARS);
    expect((lean.args as { file_path: string }).file_path).toBe('/x.ts');
  });

  test('non-strings, empty args and missing args are left alone by reference', () => {
    const numbers: WireCall = { id: 'a', name: 'X', args: { n: 3, flag: true, list: [1, 2, 3], nothing: null } };
    expect(stripArgsText(numbers)).toBe(numbers);
    const empty: WireCall = { id: 'a', name: 'X', args: {} };
    expect(stripArgsText(empty)).toBe(empty);
    const missing: WireCall = { id: 'a', name: 'X' };
    expect(stripArgsText(missing)).toBe(missing);
  });

  test('does not mutate the original', () => {
    const args = { command: SCRIPT };
    stripArgsText({ id: 'a', name: 'Bash', args });
    expect(args.command).toBe(SCRIPT);
  });
});

describe('stripDetailText: text fields blank, other long fields cut, one counter', () => {
  test('a shell: output goes blank, the long command is cut, detailBytes sums both', () => {
    const out = 'x'.repeat(4000);
    const tc: WireCall = { id: 'a', name: 'Bash', detail: { type: 'shell', command: SCRIPT, cwd: '/repo', output: out } };
    const lean = stripDetailText(tc);
    const detail = lean.detail as { command: string; cwd: string; output: string; type: string };
    expect(detail.output).toBe('');
    expect(detail.command).toBe(SCRIPT.slice(0, WIRE_STRING_PREVIEW_CHARS));
    expect(detail.cwd).toBe('/repo');
    expect(detail.type).toBe('shell');
    expect(lean.detailBytes).toBe(out.length + SCRIPT.length - WIRE_STRING_PREVIEW_CHARS);
  });

  test('an edit: oldString and newString are cut, filePath stays', () => {
    const tc: WireCall = { id: 'a', name: 'Edit', detail: { type: 'edit', filePath: '/x.ts', oldString: OVER, newString: SCRIPT } };
    const detail = stripDetailText(tc).detail as { filePath: string; oldString: string; newString: string };
    expect(detail.filePath).toBe('/x.ts');
    expect(detail.oldString.length).toBe(WIRE_STRING_PREVIEW_CHARS);
    expect(detail.newString.length).toBe(WIRE_STRING_PREVIEW_CHARS);
  });

  test('an MCP call: the long values inside detail.args are cut, the short ones stay', () => {
    const tc: WireCall = { id: 'a', name: 'mcp__x__y', detail: { type: 'mcp', server: 'x', tool: 'y', args: { body: SCRIPT, path: '/short' }, result: 'ret' } };
    const lean = stripDetailText(tc);
    const detail = lean.detail as { args: { body: string; path: string }; result: string };
    expect(detail.args.body.length).toBe(WIRE_STRING_PREVIEW_CHARS);
    expect(detail.args.path).toBe('/short');
    expect(detail.result).toBe('');
    expect(lean.detailBytes).toBe(SCRIPT.length - WIRE_STRING_PREVIEW_CHARS + 'ret'.length);
  });

  test('plan.text travels WHOLE whatever its length: the closed row summarises it', () => {
    const tc: WireCall = { id: 'a', name: 'Write', detail: { type: 'plan', text: SCRIPT } };
    expect(stripDetailText(tc)).toBe(tc);
  });

  test('nothing long and no text fields: same reference', () => {
    const tc: WireCall = { id: 'a', name: 'Read', detail: { type: 'read', filePath: '/x', offset: 1, limit: 20 } };
    expect(stripDetailText(tc)).toBe(tc);
  });
});

describe('leanToolCallForHistory / leanMessagesForHistory', () => {
  const heavy = (): WireCall => ({
    id: 'a',
    name: 'Bash',
    args: { command: SCRIPT },
    detail: { type: 'shell', command: SCRIPT, output: 'ok' },
  });

  test('both counters land on the same call, and both copies of the script are cut', () => {
    const lean = leanToolCallForHistory(heavy());
    expect(lean.argsBytes).toBe(SCRIPT.length - WIRE_STRING_PREVIEW_CHARS);
    expect(lean.detailBytes).toBe(SCRIPT.length - WIRE_STRING_PREVIEW_CHARS + 'ok'.length);
    expect(JSON.stringify(lean).length).toBeLessThan(3 * WIRE_STRING_PREVIEW_CHARS);
  });

  test('blocks: the nested toolCall is trimmed, the text block next to it is the same reference', () => {
    const text = { kind: 'text', text: 'hello' };
    const msgs = [{ id: 'm', blocks: [text, { kind: 'tool', toolCall: heavy() }] }];
    const lean = leanMessagesForHistory(msgs);
    expect(lean).not.toBe(msgs);
    expect(lean[0].blocks[0]).toBe(text);
    const tc = (lean[0].blocks[1] as { toolCall: WireCall }).toolCall;
    expect(tc.argsBytes).toBeGreaterThan(0);
    expect((tc.args as { command: string }).command.length).toBe(WIRE_STRING_PREVIEW_CHARS);
  });

  test('the legacy toolCalls bucket is trimmed too: a message from before blocks has its calls only there', () => {
    const msgs = [{ id: 'm', toolCalls: [heavy()] }];
    const lean = leanMessagesForHistory(msgs);
    expect(lean[0].toolCalls![0].argsBytes).toBeGreaterThan(0);
    expect((lean[0].toolCalls![0].args as { command: string }).command.length).toBe(WIRE_STRING_PREVIEW_CHARS);
  });

  test('a PARTIAL message is left whole: streaming is still writing into it', () => {
    const msgs = [{ id: 'm', partial: true, blocks: [{ kind: 'tool', toolCall: heavy() }] }];
    expect(leanMessagesForHistory(msgs)).toBe(msgs);
  });

  test('nothing to trim: same reference all the way down', () => {
    const light: WireCall = { id: 'a', name: 'Read', args: { file_path: '/x' }, detail: { type: 'read', filePath: '/x' } };
    const msgs = [{ id: 'm', blocks: [{ kind: 'tool', toolCall: light }] }];
    expect(leanMessagesForHistory(msgs)).toBe(msgs);
  });

  test('does not mutate the original message', () => {
    const tc = heavy();
    const msgs = [{ id: 'm', blocks: [{ kind: 'tool', toolCall: tc }] }];
    leanMessagesForHistory(msgs);
    expect((tc.args as { command: string }).command).toBe(SCRIPT);
    expect((tc.detail as { command: string; output: string }).command).toBe(SCRIPT);
    expect((tc.detail as { command: string; output: string }).output).toBe('ok');
  });
});
