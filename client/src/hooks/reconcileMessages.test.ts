import { describe, expect, it } from 'bun:test';
import type { ChatMessage } from '../types';
import { mergeFetchedHistory, reconcileMessages, sameChatMessage } from './reconcileMessages';

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

/**
 * LA RISPOSTA IN VOLO DISEGNATA DUE VOLTE.
 *
 * A metà turno `/api/history` restituisce la riga parziale (con uno stream
 * attivo i parziali non si filtrano e il contenuto vivo ci viene sovrapposto)
 * sotto il suo id di DB, mentre la finestra che sta solo guardando teneva un
 * segnaposto con un id coniato in locale. Due id per lo stesso turno: il filtro
 * additivo li teneva entrambi.
 */
describe('mergeFetchedHistory — un turno solo, non due', () => {
  const utente = (id: string, testo: string): ChatMessage =>
    ({ id, role: 'user', content: testo, timestamp: '2026-08-12T10:00:00.000Z' } as ChatMessage);
  const parziale = (id: string, testo: string): ChatMessage =>
    msg(id, testo, { partial: true });

  it('il segnaposto locale sparisce quando la storia finisce con un parziale', () => {
    const existing = [utente('u1', 'vai'), parziale('msg_1765_abc', 'sto scriv')];
    const fetched = [utente('u1', 'vai'), parziale('srv-uuid-1', 'sto scrivendo')];
    const out = mergeFetchedHistory(existing, fetched);
    expect(out).toBe(fetched);
    expect(out.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  it('un messaggio locale NON parziale resta: è roba che il server non ha ancora', () => {
    const existing = [utente('u1', 'vai'), utente('u2', 'e anche questo')];
    const fetched = [utente('u1', 'vai')];
    const out = mergeFetchedHistory(existing, fetched);
    expect(out.map((m) => m.id)).toEqual(['u1', 'u2']);
  });

  it('a turno CHIUSO il parziale locale non si butta: non c’è nessun turno vivo di cui sia il gemello', () => {
    const existing = [utente('u1', 'vai'), parziale('msg_1765_abc', 'mezza frase')];
    const fetched = [utente('u1', 'vai'), msg('srv-uuid-1', 'risposta finita')];
    const out = mergeFetchedHistory(existing, fetched);
    expect(out.map((m) => m.id)).toEqual(['u1', 'srv-uuid-1', 'msg_1765_abc']);
  });

  it('lo stesso id da entrambe le parti non si duplica', () => {
    const existing = [utente('u1', 'vai'), msg('srv-uuid-1', 'ok')];
    const fetched = [utente('u1', 'vai'), msg('srv-uuid-1', 'ok')];
    expect(mergeFetchedHistory(existing, fetched)).toBe(fetched);
  });

  it('la copia ottimistica dell’utente non resta accanto alla riga del server', () => {
    const existing = [utente('msg_1765_abc', 'beeper'), msg('srv-a1', 'eccomi')];
    const fetched = [utente('srv-u1', 'beeper'), msg('srv-a1', 'eccomi')];
    const out = mergeFetchedHistory(existing, fetched);
    expect(out).toBe(fetched);
    expect(out.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('la stessa domanda mandata DUE volte resta due volte', () => {
    const existing = [
      utente('msg_1', 'beeper'), msg('srv-a1', 'primo'),
      utente('msg_2', 'beeper'), msg('srv-a2', 'secondo'),
    ];
    const fetched = [
      utente('srv-u1', 'beeper'), msg('srv-a1', 'primo'),
      utente('srv-u2', 'beeper'), msg('srv-a2', 'secondo'),
    ];
    const out = mergeFetchedHistory(existing, fetched);
    expect(out).toBe(fetched);
    expect(out.filter((m) => m.role === 'user')).toHaveLength(2);
  });

  it('la ripetizione che il server ancora non ha resta a schermo', () => {
    const existing = [utente('srv-u1', 'beeper'), msg('srv-a1', 'primo'), utente('msg_2', 'beeper')];
    const fetched = [utente('srv-u1', 'beeper'), msg('srv-a1', 'primo')];
    const out = mergeFetchedHistory(existing, fetched);
    expect(out.map((m) => m.id)).toEqual(['srv-u1', 'srv-a1', 'msg_2']);
  });

  it('un id durevole che la storia non ha non si tocca: solo i nomi provvisori si buttano', () => {
    const existing = [utente('altra-finestra-u1', 'beeper')];
    const fetched = [utente('srv-u1', 'beeper')];
    const out = mergeFetchedHistory(existing, fetched);
    expect(out.map((m) => m.id)).toEqual(['srv-u1', 'altra-finestra-u1']);
  });
});
