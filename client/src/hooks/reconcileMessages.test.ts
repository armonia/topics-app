import { describe, expect, it } from 'bun:test';
import type { ChatMessage } from '../types';
import { reconcileMessages, sameChatMessage } from './reconcileMessages';

const msg = (id: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: 'assistant',
  content,
  timestamp: '2026-08-12T10:00:00.000Z',
  ...extra,
} as ChatMessage);

/** Ricostruisce l'oggetto passando da JSON, come fa la storia che torna dal
 *  server rispetto a quella riletta dalla cache locale. */
const roundTrip = (m: ChatMessage): ChatMessage => JSON.parse(JSON.stringify(m)) as ChatMessage;

describe('reconcileMessages — il ritorno non ri-crea ciò che c\'era già', () => {
  it('storia identica ⇒ restituisce l\'array PRECEDENTE (React salta il render)', () => {
    const prev = [msg('a', 'ciao'), msg('b', 'come va')];
    const next = prev.map(roundTrip);
    expect(reconcileMessages(prev, next)).toBe(prev);
  });

  it('un messaggio in più ⇒ array nuovo, ma i vecchi restano gli STESSI oggetti', () => {
    const prev = [msg('a', 'ciao'), msg('b', 'come va')];
    const next = [...prev.map(roundTrip), msg('c', 'nuovo')];
    const out = reconcileMessages(prev, next);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(prev[1]);
    expect(out[2].id).toBe('c');
  });

  it('un messaggio CAMBIATO porta l\'oggetto nuovo, gli altri no', () => {
    const prev = [msg('a', 'ciao'), msg('b', 'come va')];
    const next = [roundTrip(prev[0]), msg('b', 'come va, tutto bene?')];
    const out = reconcileMessages(prev, next);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).not.toBe(prev[1]);
    expect(out[1].content).toBe('come va, tutto bene?');
  });

  it('stessa lista in ordine diverso ⇒ array nuovo, identità riusate per id', () => {
    const prev = [msg('a', 'uno'), msg('b', 'due')];
    const next = [roundTrip(prev[1]), roundTrip(prev[0])];
    const out = reconcileMessages(prev, next);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(prev[1]);
    expect(out[1]).toBe(prev[0]);
  });

  it('un messaggio in MENO non può passare per «identico»', () => {
    const prev = [msg('a', 'uno'), msg('b', 'due')];
    const next = [roundTrip(prev[0])];
    expect(reconcileMessages(prev, next)).not.toBe(prev);
  });

  it('lista precedente vuota ⇒ passa la nuova così com\'è', () => {
    const next = [msg('a', 'uno')];
    expect(reconcileMessages([], next)).toBe(next);
  });
});

describe('sameChatMessage — confronto per campi, non per stringa', () => {
  it('l\'ordine delle chiavi non conta (cache locale vs risposta HTTP)', () => {
    const a = { id: 'x', role: 'user', content: 'ciao', timestamp: 't' } as unknown as ChatMessage;
    const b = { timestamp: 't', content: 'ciao', role: 'user', id: 'x' } as unknown as ChatMessage;
    expect(sameChatMessage(a, b)).toBe(true);
  });

  it('i valori annidati si confrontano nel contenuto', () => {
    const a = msg('x', 'c', { toolCalls: [{ id: 't1', name: 'Read', args: { file: 'a.ts' } }] });
    const b = msg('x', 'c', { toolCalls: [{ id: 't1', name: 'Read', args: { file: 'a.ts' } }] });
    const c = msg('x', 'c', { toolCalls: [{ id: 't1', name: 'Read', args: { file: 'b.ts' } }] });
    expect(sameChatMessage(a, b)).toBe(true);
    expect(sameChatMessage(a, c)).toBe(false);
  });

  it('un campo presente da una parte sola conta come differenza', () => {
    const a = msg('x', 'c');
    const b = msg('x', 'c', { pinned: true });
    expect(sameChatMessage(a, b)).toBe(false);
  });
});
