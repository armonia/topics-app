/**
 * La lettura del contenuto di un `tool_result`.
 *
 * I payload qui sotto non sono inventati: vengono dai risultati salvati nel DB
 * di questa macchina (dove il 14,6% mostrava l'array JSON al posto del testo) e
 * da una registrazione reale di `claude --output-format stream-json`.
 *
 * @covers TOOL-PARITY-01
 */

import { describe, expect, test } from 'bun:test';
import { toolResultText, unwrapStoredToolResult } from './tool-result-text';

describe('toolResultText', () => {
  test('una stringa resta se stessa', () => {
    expect(toolResultText('Launching skill: recap')).toBe('Launching skill: recap');
  });

  test("l'array di blocchi diventa il testo, non l'array serializzato", () => {
    const content = [{ type: 'text', text: 'Async agent launched successfully.\nagentId: a393' }];
    expect(toolResultText(content)).toBe('Async agent launched successfully.\nagentId: a393');
    expect(toolResultText(content)).not.toContain('"type"');
  });

  test('piu\' blocchi di testo si uniscono', () => {
    expect(toolResultText([
      { type: 'text', text: 'prima' },
      { type: 'text', text: 'seconda' },
    ])).toBe('prima\nseconda');
  });

  test('i tool_reference di ToolSearch diventano i nomi dei tool', () => {
    expect(toolResultText([
      { type: 'text', text: 'Loaded:' },
      { type: 'tool_reference', tool_name: 'Monitor' },
      { type: 'tool_reference', tool_name: 'WebFetch' },
    ])).toBe('Loaded:\nMonitor\nWebFetch');
  });

  test("un'immagine e' un segnaposto, non megabyte di base64", () => {
    const out = toolResultText([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo'.repeat(500) } },
    ]);
    expect(out).toBe('[immagine]');
    expect(out.length).toBeLessThan(40);
  });

  test('una forma sconosciuta non sparisce: torna grezza', () => {
    expect(toolResultText([{ type: 'boh', payload: 1 }])).toContain('boh');
  });

  test("vuoto e nullo non producono la stringa 'null'", () => {
    expect(toolResultText(null)).toBe('');
    expect(toolResultText(undefined)).toBe('');
    expect(toolResultText([])).toBe('');
  });
});

describe('unwrapStoredToolResult', () => {
  test('un risultato vecchio salvato come array serializzato torna leggibile', () => {
    const stored = JSON.stringify([{ type: 'text', text: 'Task #12 — in review' }]);
    expect(unwrapStoredToolResult(stored)).toBe('Task #12 — in review');
  });

  test('il testo normale non viene toccato', () => {
    expect(unwrapStoredToolResult('exit 0\nfatto')).toBe('exit 0\nfatto');
    expect(unwrapStoredToolResult('')).toBe('');
  });

  test('un JSON che NON e\' un array di blocchi resta com\'e\'', () => {
    // Output di un tool che restituisce dati veri: guai a sbriciolarlo.
    const json = '[{"id":1,"nome":"a"},{"id":2,"nome":"b"}]';
    expect(unwrapStoredToolResult(json)).toBe(json);
  });

  test('un array JSON di stringhe resta com\'e\' (non comincia per [{ )', () => {
    expect(unwrapStoredToolResult('["a","b"]')).toBe('["a","b"]');
  });

  test('JSON rotto: si restituisce il testo, non si lancia', () => {
    expect(unwrapStoredToolResult('[{"type":"text","text":"a')).toBe('[{"type":"text","text":"a');
  });
});
