/**
 * Le corse di tool sono UN item — e prima erano N messaggi.
 *
 * Il caso che questi test difendono è quello misurato sul DB vivo: il
 * transcript di Claude Code emette un messaggio assistant per ogni blocco,
 * quindi «una tool call, testo vuoto, blocks NULL» ripetuto ottantacinque
 * volte su centodiciassette. `toolGrouping` era giusto e restava verde: il
 * difetto era che gli arrivava sempre un array di lunghezza uno.
 */
import { describe, it, expect } from 'bun:test';
import { coalesceToolRuns, isWorkOnlyAssistant, blocksOf } from './coalesceToolRun';
import type { ChatMessage, ToolCall } from '../../types';

let seq = 0;
const tool = (name = 'Read'): ToolCall =>
  ({ id: `tc${++seq}`, name, status: 'success' } as ToolCall);

const msg = (over: Partial<ChatMessage>): ChatMessage =>
  ({
    id: `m${++seq}`,
    role: 'assistant',
    content: '',
    timestamp: '2026-08-06T00:00:00.000Z',
    ...over,
  } as ChatMessage);

/** La forma esatta che l'importer produce: un tool, niente testo, niente blocks. */
const azione = (name = 'Read') => msg({ toolCalls: [tool(name)] });

describe('cosa è una riga di cronaca', () => {
  it('un assistant senza prosa che ha agito lo è', () => {
    expect(isWorkOnlyAssistant(azione())).toBe(true);
  });

  it('un assistant che PARLA non lo è, neanche se ha agito', () => {
    expect(isWorkOnlyAssistant(msg({ content: 'fatto', toolCalls: [tool()] }))).toBe(false);
  });

  it('un messaggio in streaming non lo è mai: è vivo e non si fonde', () => {
    expect(isWorkOnlyAssistant(msg({ toolCalls: [tool()], partial: true }))).toBe(false);
  });

  it('un messaggio utente non lo è', () => {
    expect(isWorkOnlyAssistant(msg({ role: 'user', content: '' }))).toBe(false);
  });

  it('un assistant vuoto e senza lavoro non lo è (non c’è niente da fondere)', () => {
    expect(isWorkOnlyAssistant(msg({}))).toBe(false);
  });
});

describe('timeline di un messaggio', () => {
  it('i messaggi legacy la ricostruiscono dai secchi, ragionamento prima', () => {
    const b = blocksOf(msg({ thinking: 'ci penso', toolCalls: [tool('Edit')] }));
    expect(b.map((x) => x.kind)).toEqual(['thinking', 'tool']);
  });

  it('i messaggi che ce l’hanno già la usano com’è', () => {
    const blocks = [{ kind: 'text' as const, text: 'ciao' }];
    expect(blocksOf(msg({ blocks, content: 'ciao' }))).toBe(blocks);
  });
});

describe('fusione della corsa', () => {
  it('cinque azioni consecutive diventano UN item con cinque tool', () => {
    const { items } = coalesceToolRuns([
      msg({ role: 'user', content: 'vai' }),
      azione('Read'), azione('Read'), azione('Edit'), azione('Bash'), azione('Read'),
    ]);
    expect(items).toHaveLength(2); // l'utente + la corsa
    const corsa = items[1];
    expect(corsa.toolCalls).toHaveLength(5);
    expect(corsa.blocks?.map((b) => b.kind)).toEqual(['tool', 'tool', 'tool', 'tool', 'tool']);
    // È questo il numero che prima non arrivava mai a `GROUP_MIN`.
    expect(corsa.blocks).toHaveLength(5);
  });

  it('la prosa CHIUDE la corsa e resta una bolla sua', () => {
    const { items } = coalesceToolRuns([
      azione(), azione(), azione(),
      msg({ content: 'ecco il risultato' }),
    ]);
    expect(items).toHaveLength(2);
    expect(items[0].toolCalls).toHaveLength(3);
    expect(items[1].content).toBe('ecco il risultato');
  });

  it('un messaggio utente in mezzo spezza la corsa in due', () => {
    const { items } = coalesceToolRuns([
      azione(), azione(),
      msg({ role: 'user', content: 'aspetta' }),
      azione(), azione(),
    ]);
    expect(items.map((i) => i.role)).toEqual(['assistant', 'user', 'assistant']);
    expect(items[0].toolCalls).toHaveLength(2);
    expect(items[2].toolCalls).toHaveLength(2);
  });

  it('il messaggio in streaming resta fuori: non si rimescola un item vivo', () => {
    const vivo = msg({ toolCalls: [tool()], partial: true });
    const { items } = coalesceToolRuns([azione(), azione(), vivo]);
    expect(items).toHaveLength(2);
    expect(items[1]).toBe(vivo);
  });

  it('un messaggio solo non viene toccato: stesso oggetto, nessun mergedIds', () => {
    const solo = azione();
    const { items, carrierById } = coalesceToolRuns([solo]);
    expect(items[0]).toBe(solo);
    expect(items[0].mergedIds).toBeUndefined();
    expect(carrierById.size).toBe(0);
  });

  it('gli id assorbiti non si perdono: mergedIds + mappa verso il portante', () => {
    const a = azione(), b = azione(), c = azione();
    const { items, carrierById } = coalesceToolRuns([a, b, c]);
    expect(items[0].mergedIds).toEqual([a.id, b.id, c.id]);
    expect(carrierById.get(b.id)).toBe(a.id);
    expect(carrierById.get(c.id)).toBe(a.id);
    expect(carrierById.get(a.id)).toBeUndefined(); // il portante non è assorbito
  });

  it('non muta i messaggi in ingresso', () => {
    const a = azione(), b = azione();
    coalesceToolRuns([a, b]);
    expect(a.toolCalls).toHaveLength(1);
    expect((a as { mergedIds?: string[] }).mergedIds).toBeUndefined();
  });

  it('il ragionamento fra due azioni entra nella timeline al suo posto', () => {
    const { items } = coalesceToolRuns([
      azione('Read'),
      msg({ thinking: 'ora modifico' }),
      azione('Edit'),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].blocks?.map((b) => b.kind)).toEqual(['tool', 'thinking', 'tool']);
    // …e NON resta anche nel secchio vecchio, o si vedrebbe due volte.
    expect(items[0].thinking).toBeUndefined();
  });

  it('le metriche si sommano; assente + assente resta assente', () => {
    const { items } = coalesceToolRuns([
      msg({ toolCalls: [tool()], costCents: 3, usageCompletionTokens: 10 }),
      msg({ toolCalls: [tool()], costCents: 4 }),
      msg({ toolCalls: [tool()] }),
    ]);
    expect(items[0].costCents).toBe(7);
    expect(items[0].usageCompletionTokens).toBe(10);
    expect(items[0].latencyMs).toBeUndefined();
  });

  it('l’orario dell’item è quello dell’ULTIMA azione della corsa', () => {
    const { items } = coalesceToolRuns([
      msg({ toolCalls: [tool()], timestamp: '2026-08-06T10:00:00.000Z' }),
      msg({ toolCalls: [tool()], timestamp: '2026-08-06T10:00:09.000Z' }),
    ]);
    expect(items[0].timestamp).toBe('2026-08-06T10:00:09.000Z');
  });

  it('lista vuota → risultato vuoto', () => {
    const { items, carrierById } = coalesceToolRuns([]);
    expect(items).toEqual([]);
    expect(carrierById.size).toBe(0);
  });
});
