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
 *
 * @covers CHAT-01
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

  it('the live turn seen over the wire past the server snapshot keeps its chunks', () => {
    // Card 423e016f: the history was read at chunk 5, the socket delivered 6
    // and 7 before the answer came back, and the answer replaced the bubble.
    const existing = [utente('u1', 'vai'), parziale('srv-live', 'c-01 c-02 c-03 c-04 c-05 c-06 c-07 ')];
    const fetched = [utente('u1', 'vai'), parziale('srv-live', 'c-01 c-02 c-03 c-04 c-05 ')];
    const out = mergeFetchedHistory(existing, fetched);
    expect(out.map((m) => m.content)).toEqual(['vai', 'c-01 c-02 c-03 c-04 c-05 c-06 c-07 ']);
  });

  it('the kept live bubble still carries the banner only the server row has', () => {
    const existing = [utente('u1', 'vai'), msg('srv-live', 'abc', { partial: true, blocks: [{ kind: 'text', text: 'abc' }] })];
    const fetched = [utente('u1', 'vai'), msg('srv-live', 'ab', { partial: true, blocks: [{ kind: 'woken' }, { kind: 'text', text: 'ab' }] })];
    const tail = mergeFetchedHistory(existing, fetched).at(-1)!;
    expect(tail.content).toBe('abc');
    expect(tail.blocks).toEqual([{ kind: 'woken' }, { kind: 'text', text: 'abc' }] as never);
  });

  it('an answer read before a turn end seen here does not reopen the bubble the end closed', () => {
    const existing = [utente('u1', 'vai'), msg('srv-live', 'c-01 c-02 c-03 ')];
    const fetched = [utente('u1', 'vai'), parziale('srv-live', 'c-01 c-02 ')];
    const tail = mergeFetchedHistory(existing, fetched, { endedMeanwhile: true }).at(-1)!;
    expect(tail.partial).not.toBe(true);
    expect(tail.content).toBe('c-01 c-02 c-03 ');
  });

  it('the bubble an end closed here keeps the banners only the server row has', () => {
    // A woken turn is short: the answer read at its start came back after its
    // end, and the closed bubble kept here had no banner, so the Monitor's
    // event never showed until a reload (chat-monitor-visible.spec.ts, 01/10).
    const existing = [utente('u1', 'vai'), msg('srv-live', 'c-01 c-02 ', { blocks: [{ kind: 'text', text: 'c-01 c-02 ' }] })];
    const wakeBlock = { kind: 'woken', label: 'deploy log', source: 'monitor', text: 'error' };
    const fetched = [utente('u1', 'vai'), msg('srv-live', 'c-01 ', { partial: true, blocks: [wakeBlock, { kind: 'text', text: 'c-01 ' }] as never })];
    const tail = mergeFetchedHistory(existing, fetched, { endedMeanwhile: true }).at(-1)!;
    expect(tail.content).toBe('c-01 c-02 ');
    expect(tail.blocks).toEqual([wakeBlock, { kind: 'text', text: 'c-01 c-02 ' }] as never);
  });

  it('a bubble closed with no end seen during the read gives way to the server partial row', () => {
    // Closed by the stream watchdog, say, while the server still streams.
    const existing = [utente('u1', 'vai'), msg('srv-live', 'c-01 ')];
    const fetched = [utente('u1', 'vai'), parziale('srv-live', 'c-01 c-02 ')];
    expect(mergeFetchedHistory(existing, fetched)).toBe(fetched);
  });

  it('a partial row the server named and no longer has is not kept: the server deleted it', () => {
    // An empty turn stopped before it said anything: the server deletes its
    // row, and an answer read before the delete put it back here.
    const existing = [utente('u1', 'vai'), msg('srv-ok', 'ok'), utente('u2', 'altro'), parziale('srv-ghost', '')];
    const fetched = [utente('u1', 'vai'), msg('srv-ok', 'ok'), utente('u2', 'altro')];
    expect(mergeFetchedHistory(existing, fetched).map((m) => m.id)).toEqual(['u1', 'srv-ok', 'u2']);
  });

  it('the row of the turn streaming here stays, even when the read is older than it', () => {
    const existing = [utente('u1', 'vai'), parziale('srv-live', 'sto')];
    const fetched = [utente('u1', 'vai')];
    expect(mergeFetchedHistory(existing, fetched, { liveRowId: 'srv-live' }).map((m) => m.id)).toEqual(['u1', 'srv-live']);
  });

  it('a local bubble that does not start with the server text is replaced by it', () => {
    // The bubble built from the live chunks alone, without the start: the
    // server's copy is the one that holds the turn from its first word.
    const existing = [utente('u1', 'vai'), parziale('srv-live', 'c-06 c-07 ')];
    const fetched = [utente('u1', 'vai'), parziale('srv-live', 'c-01 c-02 c-03 c-04 c-05 ')];
    expect(mergeFetchedHistory(existing, fetched)).toBe(fetched);
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

/**
 * The history rows carry the send's key (`clientMessageId`, written on the
 * person's row since migration 20261003202540): a bubble still under its
 * local name is matched to its row BY KEY, and to a row without a key (stored
 * before the key was) by its words, as before.
 */
describe('mergeFetchedHistory: my bubble is known by its key', () => {
  const bubble = (id: string, content: string, key: string): ChatMessage =>
    ({ id, role: 'user', content, clientMessageId: key, timestamp: '2026-10-03T10:00:00.000Z' } as ChatMessage);
  const row = (id: string, content: string, key?: string): ChatMessage =>
    ({ id, role: 'user', content, ...(key ? { clientMessageId: key } : {}), timestamp: '2026-10-03T10:00:00.000Z' } as ChatMessage);

  it('same-words-not-mine: an older row with the same words and ANOTHER key is not taken for my bubble', () => {
    // Another device's "ok", stored before mine and not on this screen yet.
    const existing = [bubble('msg_2', 'ok', 'k-mine')];
    const fetched = [row('srv-u1', 'ok', 'k-other')];
    const out = mergeFetchedHistory(existing, fetched);
    expect(out.map((m) => m.id)).toEqual(['srv-u1', 'msg_2']);
  });

  it('two bubbles with the same words: the row with the second key takes the second, the first stays', () => {
    const existing = [bubble('msg_1', 'ok', 'k1'), bubble('msg_2', 'ok', 'k2')];
    const fetched = [row('srv-u2', 'ok', 'k2')];
    const out = mergeFetchedHistory(existing, fetched);
    expect(out.map((m) => [m.id, m.clientMessageId])).toEqual([['srv-u2', 'k2'], ['msg_1', 'k1']]);
  });

  it('the row with my key is my bubble even when its words differ from the bubble', () => {
    const existing = [bubble('msg_1', 'deploy it', 'k1')];
    const fetched = [row('srv-u1', 'deploy it\n\nand run the tests', 'k1')];
    expect(mergeFetchedHistory(existing, fetched)).toBe(fetched);
  });

  it('old-row-text-match: a row stored before the key was (no key) still matches my bubble by its words', () => {
    const existing = [bubble('msg_1', 'deploy it', 'k1')];
    const fetched = [row('srv-u1', 'deploy it')];
    expect(mergeFetchedHistory(existing, fetched)).toBe(fetched);
  });
});

/**
 * A history page that lands after the catch-up must not wipe the output of a
 * running command: during a silent command the text does not grow, so the
 * server's copy is never "ahead" and used to replace the bubble whole.
 *
 * @covers CHAT-TOOL-11
 */
describe('mergeFetchedHistory: the running tools keep the output on screen', () => {
  const running = { id: 't-live', name: 'Bash', args: { command: 'bun test' }, status: 'running' as const, startedAt: 1_000 };
  const withTool = (id: string, content: string, toolCall: Record<string, unknown>, extra: Partial<ChatMessage> = {}) =>
    msg(id, content, { partial: true, blocks: [{ kind: 'tool', toolCall }], toolCalls: [toolCall], ...extra } as Partial<ChatMessage>);
  const shown = (m: ChatMessage | undefined) => (m?.blocks?.[0] as { toolCall?: { result?: string } } | undefined)?.toolCall?.result;

  it('a page without the tail keeps the one on screen, in the blocks and in the bucket', () => {
    const user = { ...msg('u1', 'go'), role: 'user' } as ChatMessage;
    const existing = [user, withTool('row-1', 'Running.', { ...running, result: 'r1\nr2\nr3' })];
    const fetched = [user, withTool('row-1', 'Running.', running)];
    const out = mergeFetchedHistory(existing, fetched, { liveRowId: 'row-1' });
    expect(shown(out[1])).toBe('r1\nr2\nr3');
    expect(out[1]!.toolCalls?.[0]?.result).toBe('r1\nr2\nr3');
  });

  it('a page with a tail of its own wins: it is the newer one', () => {
    const existing = [withTool('row-1', 'Running.', { ...running, result: 'r1' })];
    const fetched = [withTool('row-1', 'Running.', { ...running, result: 'r1\nr2' })];
    expect(shown(mergeFetchedHistory(existing, fetched)[0])).toBe('r1\nr2');
  });

  it('a call the page closed takes the page, not the tail', () => {
    const existing = [withTool('row-1', 'Running.', { ...running, result: 'r1' })];
    const fetched = [withTool('row-1', 'Running.', { ...running, status: 'success', result: '3 pass' })];
    expect(shown(mergeFetchedHistory(existing, fetched)[0])).toBe('3 pass');
  });

  it('a page with nothing to keep is returned as it came', () => {
    const existing = [withTool('row-1', 'Running.', running)];
    const fetched = [withTool('row-1', 'Running.', running)];
    expect(mergeFetchedHistory(existing, fetched)).toBe(fetched);
  });
});
