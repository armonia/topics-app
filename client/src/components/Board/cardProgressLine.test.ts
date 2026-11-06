/**
 * The progress line of a card in progress: its text, checked as a value.
 *
 * These are facts about the output, not about the source: an empty line where
 * a tool step belongs, or the agent's whole word instead of its first line,
 * fails here and not only in a rendered page.
 */
import { describe, expect, test } from 'bun:test';
import { cardProgressLine } from './cardProgressLine';

const tool = { name: 'Bash', input: 'bun run test:unit', since: 0 };
const working = { lastTool: tool, retry: undefined, working: true, showsQuestion: true, bodyText: 'Ho letto il brief.' };

describe('cardProgressLine', () => {
  test('il passo del tool in corso è la riga: nome · input', () => {
    expect(cardProgressLine(working)).toBe('Bash · bun run test:unit');
  });

  test('un tool senza input è solo il nome, senza separatore vuoto', () => {
    expect(cardProgressLine({ ...working, lastTool: { ...tool, input: null } })).toBe('Bash');
  });

  test('senza tool in corso la riga è la PRIMA riga dell\'agente, mai il testo intero', () => {
    const r = cardProgressLine({ ...working, lastTool: null, bodyText: 'Prima riga.\nSeconda riga, che non deve comparire.' });
    expect(r).toBe('Prima riga.');
  });

  test('il markdown non entra nella riga', () => {
    expect(cardProgressLine({ ...working, lastTool: null, bodyText: '**Fatto**: vedi `Card.tsx`' })).not.toContain('**');
  });

  test('un testo vuoto o di soli a capo non produce una riga', () => {
    expect(cardProgressLine({ ...working, lastTool: null, bodyText: '' })).toBe('');
    expect(cardProgressLine({ ...working, lastTool: null, bodyText: '\n  \n' })).toBe('');
    expect(cardProgressLine({ ...working, lastTool: null, bodyText: null })).toBe('');
  });

  test('una card che non lavora, o in retry, non mostra il passo del tool', () => {
    expect(cardProgressLine({ ...working, working: false, bodyText: null })).toBe('');
    expect(cardProgressLine({ ...working, retry: { attempt: 2 }, bodyText: null })).toBe('');
  });

  test('senza domanda visibile (showsQuestion false) il testo dell\'agente non diventa la riga', () => {
    expect(cardProgressLine({ ...working, lastTool: null, showsQuestion: false })).toBe('');
  });
});
