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

/**
 * L'IDENTITÀ DEGLI ITEM È LA PRESTAZIONE.
 *
 * `MessageBubble` è `memo`: salta il render solo se il messaggio che riceve è
 * lo STESSO oggetto di prima. Rifondendo tutto a ogni token, ogni corsa già
 * chiusa tornava come oggetto nuovo — quindi tutte le bolle di tool visibili si
 * ridisegnavano a ogni frame di streaming, e nessun test se ne accorgeva perché
 * il VALORE era giusto. Qui si prova il riferimento, che è la cosa che conta.
 */
describe('stabilità del riferimento fra due chiamate', () => {
  /** La bolla viva: `partial`, quindi non si fonde mai — è la coda che cresce. */
  const viva = (testo: string, id: string): ChatMessage =>
    msg({ id, content: testo, partial: true });

  it('la corsa già chiusa NON si riconia quando cresce solo la coda viva', () => {
    const corsa = [azione('Read'), azione('Edit'), azione('Bash')];
    const primo = coalesceToolRuns([...corsa, viva('ci sto', 'live')]);
    const secondo = coalesceToolRuns([...corsa, viva('ci sto lavor', 'live')]);
    expect(primo.items[0].toolCalls).toHaveLength(3);
    expect(secondo.items[0]).toBe(primo.items[0]);
    // …e la coda viva è l'unico item nuovo.
    expect(secondo.items[1]).not.toBe(primo.items[1]);
    expect(secondo.items).toHaveLength(2);
  });

  it('un messaggio nuovo in coda lascia intatti gli item di prima', () => {
    const testa = [msg({ role: 'user', content: 'vai' }), azione('Read'), azione('Edit')];
    const primo = coalesceToolRuns(testa);
    const secondo = coalesceToolRuns([...testa, msg({ content: 'ecco' })]);
    expect(secondo.items[0]).toBe(primo.items[0]);
    expect(secondo.items[1]).toBe(primo.items[1]);
    expect(secondo.items[2].content).toBe('ecco');
  });

  it('ma un\'azione nuova in coda RIAPRE la corsa: l\'item cresce, non si congela', () => {
    const corsa = [azione('Read'), azione('Edit')];
    const primo = coalesceToolRuns(corsa);
    const secondo = coalesceToolRuns([...corsa, azione('Bash')]);
    expect(secondo.items).toHaveLength(1);
    expect(secondo.items[0].toolCalls).toHaveLength(3);
    expect(secondo.items[0]).not.toBe(primo.items[0]);
  });

  it('la stessa lista due volte torna lo stesso identico risultato', () => {
    const lista = [azione('Read'), azione('Edit'), msg({ content: 'fatto' })];
    const primo = coalesceToolRuns(lista);
    const secondo = coalesceToolRuns(lista);
    expect(secondo.items).toBe(primo.items);
    expect(secondo.carrierById).toBe(primo.carrierById);
  });

  it('la memoria non falsifica: cambiando la TESTA si rifonde tutto', () => {
    const coda = [azione('Read'), azione('Edit')];
    const primo = coalesceToolRuns([msg({ role: 'user', content: 'a' }), ...coda]);
    const secondo = coalesceToolRuns([msg({ role: 'user', content: 'b' }), ...coda]);
    expect(secondo.items[0].content).toBe('b');
    expect(secondo.items[1].toolCalls).toHaveLength(2);
    expect(secondo.items[1]).not.toBe(primo.items[1]);
  });
});

/**
 * LA MEMORIA HA UNA SCADENZA, non solo un tetto.
 *
 * Quattro voci limitano QUANTE, non PER QUANTO: ogni voce trattiene l'array dei
 * messaggi, i portanti fusi e le mappe di un trascritto, e senza scadenza li
 * teneva per la vita della pagina — anche di una pane chiusa un'ora fa o di una
 * sessione che lo spazzino della residenza aveva già sfrattato.
 *
 * L'orologio si passa per argomento: la scadenza si prova solo se si può far
 * passare il tempo senza aspettarlo.
 */
describe('scadenza della memoria', () => {
  const T0 = 1_800_000_000_000;
  const MINUTO = 60_000;

  it('un trascritto che nessuno disegna da un minuto viene lasciato andare', () => {
    const corsa = [azione('Read'), azione('Bash')];
    const primo = coalesceToolRuns(corsa, T0);
    // Stessa chiamata, stesso istante: è la memoria che risponde.
    expect(coalesceToolRuns(corsa, T0).items).toBe(primo.items);

    // Passa il minuto e disegna QUALCUN ALTRO: la voce vecchia se ne va.
    coalesceToolRuns([azione('Grep')], T0 + MINUTO + 1);

    const dopo = coalesceToolRuns(corsa, T0 + MINUTO + 1);
    expect(dopo.items).not.toBe(primo.items);
    // E il risultato è lo stesso: si è pagata una ricostruzione, non un errore.
    expect(dopo.items.length).toBe(1);
    expect(dopo.items[0].toolCalls?.length).toBe(2);
  });

  it('la scadenza si misura dall’ULTIMO disegno, non dalla nascita', () => {
    const corsa = [azione('Read'), azione('Bash')];
    const primo = coalesceToolRuns(corsa, T0);
    // Disegnata di continuo: a schermo il chiamante ripassa a ogni frame.
    coalesceToolRuns(corsa, T0 + MINUTO - 1);
    const tardi = coalesceToolRuns(corsa, T0 + 2 * MINUTO - 2);
    expect(tardi.items).toBe(primo.items);
  });
});
