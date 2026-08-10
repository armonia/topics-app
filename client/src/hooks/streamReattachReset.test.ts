import { describe, expect, test } from 'bun:test';
import { clearPartialForReattach } from './streamReattachReset';
import type { ChatMessage } from '../types';

function partial(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'a1',
    role: 'assistant',
    content: 'mezz’ora di lavoro',
    timestamp: '2026-08-10T15:46:22.678Z',
    partial: true,
    ...over,
  } as ChatMessage;
}

const utente: ChatMessage = {
  id: 'u1', role: 'user', content: 'vedi che manca', timestamp: '2026-08-10T15:46:22.526Z',
} as ChatMessage;

describe('clearPartialForReattach — si azzera la vista, non il record', () => {
  test('svuota la bolla in volo tenendo il suo id (stessa bolla, non un doppione)', () => {
    const prima = [utente, partial({ thinking: 'ragionavo', toolCalls: [{ id: 't1' } as never], blocks: [{ kind: 'text', text: 'x' } as never] })];
    const dopo = clearPartialForReattach(prima);

    expect(dopo).not.toBe(prima);
    expect(dopo.length).toBe(2);
    const bolla = dopo[1];
    expect(bolla.id).toBe('a1'); // stessa bolla
    expect(bolla.partial).toBe(true); // ancora in volo: lo spinner non sparisce
    expect(bolla.content).toBe('');
    expect(bolla.thinking).toBeUndefined();
    expect(bolla.toolCalls).toBeUndefined();
    expect(bolla.blocks).toBeUndefined();
    expect(dopo[0]).toBe(utente); // il messaggio dell'utente non si tocca
  });

  test('bolla già vuota: stesso array, nessun ridisegno', () => {
    const prima = [utente, partial({ content: '' })];
    expect(clearPartialForReattach(prima)).toBe(prima);
  });

  test('turno già chiuso: non si tocca un messaggio finalizzato', () => {
    const finito = partial({ partial: false });
    const prima = [utente, finito];
    expect(clearPartialForReattach(prima)).toBe(prima);
    expect(finito.content).toBe('mezz’ora di lavoro');
  });

  test('ultimo messaggio dell’utente (nessuna bolla): niente da svuotare', () => {
    const prima = [utente];
    expect(clearPartialForReattach(prima)).toBe(prima);
  });

  test('sessione vuota', () => {
    const prima: ChatMessage[] = [];
    expect(clearPartialForReattach(prima)).toBe(prima);
  });
});
