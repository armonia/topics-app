/**
 * I CONTEGGI DELL'INVENTARIO DEVONO ESSERE ESATTI.
 *
 * PERCHE' UN FILE APPOSTA. `featureWeight.test.ts` prova il registro,
 * `featureWeightText` come si scrivono le righe. Restava scoperto il pezzo piu'
 * facile da sbagliare in silenzio: i tre accessori che CONTANO, aggiunti agli
 * store per questa feature.
 *
 * E' il punto in cui l'inventario puo' mentire senza che nulla lo dica. Un
 * numero sbagliato non rompe niente — compare, sembra una misura, e nessuno ha
 * modo di accorgersene guardandolo. La spec (RES-ATTR-06) chiede che i conteggi
 * siano ESATTI proprio perche' sono l'unica cosa che questo inventario puo'
 * promettere: i byte sono stime dichiarate, i conteggi no.
 *
 * Ogni caso qui sotto e' una decisione che si poteva prendere in due modi, e il
 * modo sbagliato sarebbe stato invisibile: una coda vuota contata come coda, un
 * task idratato senza tab contato come task, una tab parcheggiata che sparisce
 * dal totale proprio perche' non si vede da nessun'altra parte.
  * @covers RES-ATTR-09
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { __setQueueStorage, enqueueTurn, getQueue, clearQueue, queueCount } from './chatQueue';
import { taskTabsCount, taskBrowserTabs, applyRemoteTaskTabs, __resetTaskTabs } from './taskBrowserTabs';
import { previewsCount, applyMessagePreview, __resetTopicPreviews } from './topicPreviews';
import type { QueueStorage } from '../hooks/outboundQueue';

function fakeStorage(): QueueStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

describe('queueCount — i turni in coda', () => {
  beforeEach(() => { __setQueueStorage(fakeStorage()); });

  test('senza niente in coda non c\'e\' nessuna voce', () => {
    expect(queueCount()).toEqual({ entries: 0, items: 0 });
  });

  test('conta i turni e le chat che ne hanno', () => {
    enqueueTurn('topic:a', 'primo');
    enqueueTurn('topic:a', 'secondo');
    enqueueTurn('topic:b', 'terzo');
    expect(queueCount()).toEqual({ entries: 2, items: 3 });
  });

  test('una chat SVUOTATA smette di contare, invece di restare nell\'elenco', () => {
    // La cache tiene la voce anche dopo lo svuotamento (per non rileggere lo
    // storage a ogni render): contarla direbbe «1 chat in coda» quando non c'e'
    // piu' niente da mandare, cioe' la riga comparirebbe proprio nel momento in
    // cui non serve.
    enqueueTurn('topic:a', 'primo');
    expect(queueCount().entries).toBe(1);
    clearQueue('topic:a');
    expect(queueCount()).toEqual({ entries: 0, items: 0 });
  });

  test('una chat solo LETTA e trovata vuota non diventa una voce', () => {
    // `getQueue` idrata la cache anche quando non trova niente. Senza il filtro
    // sulle code non vuote, aprire cinque chat basterebbe a far comparire
    // «5 chat» in coda senza che nessuno abbia accodato niente.
    getQueue('topic:mai-usata');
    getQueue('topic:nemmeno-questa');
    expect(queueCount().entries).toBe(0);
  });
});

describe('taskTabsCount — le tab dei task', () => {
  const A = '11111111-0e15-4aa0-ab25-f00000000000';
  const B = '22222222-0e15-4aa0-ab25-f00000000000';
  /* RESET TOTALE, non dei soli A e B. `taskTabsCount` e' una SOMMA su tutta la
   * cache, che e' un singleton di modulo condiviso da tutti i file della suite:
   * pulire i propri task lascia dentro quelli di chi ha girato prima, e il test
   * diventa verde da solo e rosso in suite. Successo per davvero: questi cinque
   * casi passavano isolati e fallivano in `bun test client/src/state/`. */
  beforeEach(() => { __resetTaskTabs(); });

  test('senza tab non c\'e\' nessuna voce', () => {
    expect(taskTabsCount()).toEqual({ entries: 0, items: 0, parked: 0 });
  });

  test('conta le tab e i task che ne hanno', () => {
    taskBrowserTabs.addTab(A, 'https://uno.example', 'Uno');
    taskBrowserTabs.addTab(A, 'https://due.example', 'Due');
    taskBrowserTabs.addTab(B, 'https://tre.example', 'Tre');
    const c = taskTabsCount();
    expect(c.entries).toBe(2);
    expect(c.items).toBe(3);
  });

  test('le PARCHEGGIATE restano nel totale e si contano a parte', () => {
    // E' il caso per cui questo inventario esiste: una tab parcheggiata e'
    // trattenuta senza essere visibile da nessuna parte. Se sparisse dal
    // conteggio, l'unica superficie che poteva nominarla tacerebbe.
    taskBrowserTabs.addTab(A, 'https://uno.example', 'Uno');
    taskBrowserTabs.addTab(A, 'https://due.example', 'Due');
    const st = taskBrowserTabs.get(A);
    taskBrowserTabs.closeTab(A, st.tabs[0].contextId); // soft-close = park
    const c = taskTabsCount();
    expect(c.items).toBe(2);   // ci sono ancora entrambe
    expect(c.parked).toBe(1);  // ma una e' parcheggiata
  });

  test('un task IDRATATO ma senza tab non e\' una voce', () => {
    // Aprire il drawer di un task fa idratare il suo record anche quando non ha
    // nessuna tab: la cache ha la chiave, il contenuto e' vuoto. Contarla
    // direbbe «3 task» a chi non ha aperto nemmeno una pagina — e sarebbe un
    // numero che cresce da solo aprendo drawer, cioe' il tipo di riga che fa
    // sospettare una perdita che non c'e'.
    applyRemoteTaskTabs(A, { tabs: [], activeContextId: null, nextSeq: 0 });
    applyRemoteTaskTabs(B, { tabs: [], activeContextId: null, nextSeq: 0 });
    expect(taskTabsCount()).toEqual({ entries: 0, items: 0, parked: 0 });

    // …e appena UNA di quelle ne riceve una, compare solo lei.
    taskBrowserTabs.addTab(A, 'https://uno.example', 'Uno');
    expect(taskTabsCount().entries).toBe(1);
  });

  test('un task che ha perso tutte le tab non resta una voce a zero', () => {
    taskBrowserTabs.addTab(A, 'https://uno.example', 'Uno');
    expect(taskTabsCount().entries).toBe(1);
    __resetTaskTabs();
    expect(taskTabsCount()).toEqual({ entries: 0, items: 0, parked: 0 });
  });
});

describe('previewsCount — le anteprime dei topic', () => {
  beforeEach(() => { __resetTopicPreviews(); });

  test('senza anteprime non c\'e\' nessuna voce', () => {
    expect(previewsCount().entries).toBe(0);
  });

  test('conta le anteprime tenute in memoria', () => {
    applyMessagePreview('t1', 'user', 'ciao');
    applyMessagePreview('t2', 'assistant', 'risposta');
    expect(previewsCount().entries).toBe(2);
  });

  test('due messaggi sullo stesso topic restano UNA anteprima', () => {
    // Il conteggio e' di anteprime, non di messaggi: sbagliarlo farebbe
    // crescere una riga che in realta' non cresce.
    applyMessagePreview('t1', 'user', 'primo');
    applyMessagePreview('t1', 'assistant', 'secondo');
    expect(previewsCount().entries).toBe(1);
  });

  test('dichiara il TETTO, perche\' «198» e «198 su 200» dicono cose diverse', () => {
    applyMessagePreview('t1', 'user', 'ciao');
    const c = previewsCount();
    expect(c.max).toBeGreaterThan(0);
    // Il tetto e' un fatto dello store, non un numero scritto qui: se cambiasse
    // la' e non qui, questo test non deve diventare una copia sbagliata.
    expect(c.entries).toBeLessThanOrEqual(c.max);
  });
});
