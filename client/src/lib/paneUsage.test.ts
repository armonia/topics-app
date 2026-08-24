/**
 * `paneUsage` — i TRE stati devono restare tre.
 *
 * Il difetto che questi test tengono chiuso: collassare "non ha un processo",
 * "non ancora misurato" e "misurato, quasi zero" in un unico `0` o `—`. Sono
 * tre cose diverse, e l'unica disonesta sarebbe mostrare uno zero per le prime
 * due — un numero inventato con l'aria di una misura.
 *
 * @covers RES-ATTR-04, RES-ATTR-05
 *
 * RES-ATTR-04: l'attribuzione non moltiplica il costo del campionamento.
 * RES-ATTR-05: una pane senza processo proprio si DICHIARA tale invece di
 * ricevere una quota inventata con l'aria di una misura.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  formatPaneUsageLine,
  getPaneUsage,
  ensurePaneUsageFresh,
  getBrowserPaneUsage,
  browserPaneLabel,
  paneIdFromWebviewLabel,
  _resetPaneUsage,
  _setPaneUsageSnapshot,
} from './paneUsage';
import { replaceAllMessages, __resetMessageStore } from '../state/messageStore';

describe('formatPaneUsageLine', () => {
  beforeEach(() => { _resetPaneUsage(); });

  it('una pane senza processo proprio lo DICE, non mostra zero', () => {
    // topic, kanban, chat, file, editor: componenti React nello stesso
    // renderer. Nessun `ps` può separarle, quindi non esiste una misura.
    const line = formatPaneUsageLine('qualsiasi', false);
    expect(line).toContain('non ha un processo proprio');
    expect(line).not.toContain('0 MB');
    expect(line).not.toContain('0%');
  });

  it('una pane con processo ma senza misura dice "non ancora misurato"', () => {
    const line = formatPaneUsageLine('s-ignota', true);
    expect(line).toContain('non ancora misurato');
    expect(line).not.toContain('0 MB');
  });

  it('CPU null = "non ancora misurata", NON "0%"', () => {
    // Un processo appena nato non ha un delta da cui ricavare una percentuale.
    _setPaneUsageSnapshot([{ sessionId: 's-nuova', memoryMB: 120, cpuPercent: null, processCount: 1 }]);
    const line = formatPaneUsageLine('s-nuova', true);
    expect(line).toContain('120 MB');
    expect(line).toContain('CPU non ancora misurata');
    expect(line).not.toContain('CPU 0%');
  });

  it('CPU zero misurata è uno zero VERO e si vede come tale', () => {
    _setPaneUsageSnapshot([{ sessionId: 's-ferma', memoryMB: 90, cpuPercent: 0, processCount: 2 }]);
    const line = formatPaneUsageLine('s-ferma', true);
    expect(line).toContain('CPU 0%');
    expect(line).toContain('2 processi');
  });

  it('una misura piccola non diventa zero', () => {
    // Stessa regola di `formatCpuPercent` nella status bar: 0,3% è una misura,
    // e arrotondarla a "0%" la farebbe passare per assente.
    _setPaneUsageSnapshot([{ sessionId: 's-bassa', memoryMB: 40, cpuPercent: 0.3, processCount: 1 }]);
    const line = formatPaneUsageLine('s-bassa', true);
    expect(line).toContain('<1%');
    expect(line).toContain('1 processo');
  });

  it('singolare e plurale dei processi', () => {
    _setPaneUsageSnapshot([
      { sessionId: 'uno', memoryMB: 1, cpuPercent: 1, processCount: 1 },
      { sessionId: 'tanti', memoryMB: 1, cpuPercent: 1, processCount: 7 },
    ]);
    expect(formatPaneUsageLine('uno', true)).toContain('1 processo');
    expect(formatPaneUsageLine('tanti', true)).toContain('7 processi');
  });

  it('un sessionId assente non esplode', () => {
    _setPaneUsageSnapshot([{ sessionId: 'x', memoryMB: 1, cpuPercent: 1, processCount: 1 }]);
    expect(getPaneUsage(null)).toBeNull();
    expect(getPaneUsage(undefined)).toBeNull();
    expect(formatPaneUsageLine(null, true)).toContain('non ancora misurato');
  });
});

describe('pane browser (RES-ATTR-02)', () => {
  beforeEach(() => { _resetPaneUsage(); });

  it('una pane browser si cerca per label di webview, non per sessione', () => {
    // Sono due sorgenti diverse: il server non vede le webview (vivono nella
    // shell) e la shell non vede i sidecar. Cercare un browser fra le sessioni
    // darebbe sempre "non misurato" anche a misura presente.
    _setPaneUsageSnapshot([], {
      webviews: [{ label: browserPaneLabel('pane-42'), memoryMB: 310, cpuPercent: 12 }],
    });
    expect(getBrowserPaneUsage('pane-42')?.memoryMB).toBe(310);
    expect(getPaneUsage('pane-42')).toBeNull();
    const line = formatPaneUsageLine(null, true, 'pane-42');
    expect(line).toContain('310 MB');
    expect(line).toContain('CPU 12%');
    expect(line).toContain('1 processo');
  });

  it('il label deve restare allineato a `browser_label` nella shell', () => {
    // Se il prefisso cambia da una parte sola, il tooltip smette di trovare la
    // misura e nessun test se ne accorgerebbe altrimenti.
    expect(browserPaneLabel('abc')).toBe('browserpane-abc');
  });

  it('una pane RICREATA non perde la misura, e paga anche la vista che non è morta', () => {
    // Vista col mutex avvelenato: rifiuta di chiudersi, resta registrata sotto
    // l'etichetta vecchia, e la pane riapre su una generazione nuova
    // (`browser_close`/`burn_pane_label` in lib.rs). Cercare la sola etichetta
    // esatta avrebbe fatto sparire il numero proprio dopo la ricreazione — e
    // due processi WebContent su una pane sola sono la cosa da vedere, non da
    // nascondere.
    _setPaneUsageSnapshot([], {
      webviews: [
        { label: 'browserpane-pane-7', memoryMB: 400, cpuPercent: 0 },   // la morta
        { label: 'browserpane-~1~pane-7', memoryMB: 120, cpuPercent: 12 }, // la nuova
      ],
    });
    const usage = getBrowserPaneUsage('pane-7');
    expect(usage?.memoryMB).toBe(520);
    expect(usage?.processCount).toBe(2);
  });

  it('la generazione si legge solo quando è una generazione', () => {
    // Un id che comincia per `~` non va mutilato: meglio non riconoscerlo che
    // attribuire la misura a una pane sbagliata.
    expect(paneIdFromWebviewLabel('browserpane-abc')).toBe('abc');
    expect(paneIdFromWebviewLabel('browserpane-~2~abc')).toBe('abc');
    expect(paneIdFromWebviewLabel('browserpane-~abc')).toBe('~abc');
    expect(paneIdFromWebviewLabel('browserpane-~x~abc')).toBe('~x~abc');
    expect(paneIdFromWebviewLabel('main')).toBeNull();
  });

  it('una pane browser senza webview associata dice "non ancora misurato"', () => {
    // Il caso reale del primo campionamento: `_webProcessIdentifier` ritorna 0
    // finché il contenuto non è caricato, quindi la mappa non ha ancora la voce.
    _setPaneUsageSnapshot([], { webviews: [] });
    expect(formatPaneUsageLine(null, true, 'pane-nuova')).toContain('non ancora misurato');
  });

  it('un terminale non pesca per sbaglio dalle webview', () => {
    _setPaneUsageSnapshot(
      [{ sessionId: 's-term', memoryMB: 55, cpuPercent: 2, processCount: 3 }],
      { webviews: [{ label: browserPaneLabel('s-term'), memoryMB: 999, cpuPercent: 99 }] },
    );
    const line = formatPaneUsageLine('s-term', true);
    expect(line).toContain('55 MB');
    expect(line).not.toContain('999');
  });
});

describe('costo del campionamento (RES-ATTR-04)', () => {
  // Il requisito: il numero di letture NON deve crescere col numero di pane.
  // È la ragione per cui questo store esiste invece di riusare
  // `useSystemStatus`, che fa un `setInterval` PER ISTANZA — dieci gruppi di
  // tab avrebbero significato dieci polling paralleli sullo stesso dato.
  const realFetch = globalThis.fetch;
  let calls = 0;

  beforeEach(() => {
    _resetPaneUsage();
    calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({
        server: { fleet: { sessions: [{ sessionId: 's', name: 'x', pid: 1, memoryMB: 10, cpuPercent: 1, processCount: 1 }], cpuCores: 12, memMetric: 'footprint' } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; _resetPaneUsage(); });

  it('venti tab che chiedono insieme producono UNA richiesta', async () => {
    for (let i = 0; i < 20; i++) ensurePaneUsageFresh();
    await new Promise(r => setTimeout(r, 20));
    expect(calls).toBe(1);
  });

  it('dentro la finestra di validità non si richiede di nuovo', async () => {
    ensurePaneUsageFresh();
    await new Promise(r => setTimeout(r, 20));
    expect(calls).toBe(1);
    for (let i = 0; i < 10; i++) ensurePaneUsageFresh();
    await new Promise(r => setTimeout(r, 20));
    expect(calls).toBe(1); // il dato è ancora fresco: nessuna seconda lettura
    expect(getPaneUsage('s')?.memoryMB).toBe(10);
  });

  it('una richiesta fallita non lascia lo store bloccato', async () => {
    globalThis.fetch = (async () => { calls++; throw new Error('offline'); }) as unknown as typeof fetch;
    ensurePaneUsageFresh();
    await new Promise(r => setTimeout(r, 20));
    expect(calls).toBe(1);
    // `inFlight` deve essersi liberato, altrimenti nessun tentativo successivo
    // partirebbe mai più e il tooltip resterebbe muto per sempre.
    ensurePaneUsageFresh();
    await new Promise(r => setTimeout(r, 20));
    expect(calls).toBe(2);
  });

  it('un errore di rete non cancella l\'ultimo dato buono', async () => {
    ensurePaneUsageFresh();
    await new Promise(r => setTimeout(r, 20));
    expect(getPaneUsage('s')?.memoryMB).toBe(10);
    _setPaneUsageSnapshot([{ sessionId: 's', memoryMB: 10, cpuPercent: 1, processCount: 1 }]);
    globalThis.fetch = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    await new Promise(r => setTimeout(r, 4100)); // scade il TTL
    ensurePaneUsageFresh();
    await new Promise(r => setTimeout(r, 20));
    // Meglio l'ultimo numero buono che un tooltip che lampeggia a vuoto.
    expect(getPaneUsage('s')?.memoryMB).toBe(10);
  });

});

describe('una chat dice cosa TIENE, non cosa non e\'', () => {
  /* IL DIFETTO SEGNALATO. Passando il mouse su una tab di chat usciva solo
   * «questa scheda non ha un processo proprio»: vero, e inutile — risponde a
   * com'e' implementata la scheda, non a cosa costa. L'utente l'ha riportato
   * come «non vedo dove esce il consumo», ed era la lettura giusta.
   *
   * Il conteggio dei messaggi non e' un ripiego: e' l'unica cosa ESATTA che si
   * possa dire di un componente dentro un renderer condiviso. I MB non si
   * attribuiscono (RES-ATTR-05), i messaggi si contano. */
  beforeEach(() => { _resetPaneUsage(); __resetMessageStore(); });
  afterEach(() => { __resetMessageStore(); });

  it('conta i messaggi che quella chat tiene in memoria', () => {
    replaceAllMessages({
      'topic:abc': [{ id: '1' }, { id: '2' }, { id: '3' }] as never,
    });
    const line = formatPaneUsageLine(null, false, null, 'topic:abc');
    expect(line).toContain('3 messaggi');
    // E NON MISURA in megabyte: quelli non si possono attribuire a un
    // componente dentro un renderer condiviso.
    //
    // L'asserzione e' su «un numero seguito da MB» e non sulla stringa «MB»
    // nuda: la riga di spiegazione la contiene di proposito («i MB non si
    // attribuiscono»), ed e' quella che rende il conteggio comprensibile. Il
    // primo tentativo vietava la sottostringa e falliva sulla frase giusta.
    expect(line).not.toMatch(/\d+\s*MB/);
  });

  it('un messaggio solo si scrive al singolare', () => {
    replaceAllMessages({ 'topic:abc': [{ id: '1' }] as never });
    expect(formatPaneUsageLine(null, false, null, 'topic:abc')).toContain('1 messaggio');
  });

  it('dice ANCHE perche\' non ci sono MB: senza, il conteggio sembra tutto', () => {
    replaceAllMessages({ 'topic:abc': [{ id: '1' }] as never });
    const line = formatPaneUsageLine(null, false, null, 'topic:abc');
    expect(line).toContain('Nessun processo proprio');
  });

  it('una chat VUOTA ricade sulla riga generica invece di dire «0 messaggi»', () => {
    // Uno zero qui somiglia a una misura ed e' solo «non c\'e\' ancora niente».
    const line = formatPaneUsageLine(null, false, null, 'topic:mai-aperta');
    expect(line).toContain('non ha un processo proprio');
    expect(line).not.toContain('0 messaggi');
  });

  it('senza sessionKey il comportamento e\' quello di prima', () => {
    // Kanban, file, editor: non sono chat e non hanno messaggi da contare.
    const line = formatPaneUsageLine(null, false, null, null);
    expect(line).toContain('non ha un processo proprio');
  });

  it('una pane CON processo non passa mai di qui', () => {
    // La sessionKey non deve poter dirottare una misura vera.
    _setPaneUsageSnapshot([{ sessionId: 's1', memoryMB: 396, cpuPercent: 3, processCount: 2 }]);
    replaceAllMessages({ 'topic:abc': [{ id: '1' }] as never });
    const line = formatPaneUsageLine('s1', true, null, 'topic:abc');
    expect(line).toContain('396 MB');
    expect(line).not.toContain('messaggi');
  });
});
