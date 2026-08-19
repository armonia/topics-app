import { describe, expect, test } from 'bun:test';
import {
  CONSOLE_FILTERS,
  buildConsoleView,
  consoleTime,
  formatConsoleRows,
  type ConsoleFilter,
} from './consoleLogModel';
import type { BrowserConsoleEntry } from './browserDevTypes';

let nextId = 0;
function e(
  level: BrowserConsoleEntry['level'],
  text: string,
  extra: { source?: string; at?: number } = {},
): BrowserConsoleEntry {
  return { id: ++nextId, level, text, source: extra.source, at: extra.at ?? 0 };
}

/** Un'ora COSTRUITA nel fuso locale: `new Date(epoch)` con un numero fisso
 *  darebbe una stringa diversa a Roma e su un runner in UTC, e il test
 *  fallirebbe per il fuso della macchina invece che per il codice. */
function localAt(h: number, m: number, s: number): number {
  return new Date(2026, 7, 19, h, m, s).getTime();
}

describe('consoleTime', () => {
  test('hh:mm:ss con gli zeri davanti, in 24 ore', () => {
    expect(consoleTime(localAt(9, 7, 3))).toBe('09:07:03');
    expect(consoleTime(localAt(23, 59, 59))).toBe('23:59:59');
    expect(consoleTime(localAt(0, 0, 0))).toBe('00:00:00');
  });

  test('senza ora resta un segnaposto della STESSA larghezza', () => {
    // La colonna e' a larghezza fissa: una cella vuota sposterebbe il testo di
    // quella riga rispetto a tutte le altre.
    expect(consoleTime(0)).toBe('--:--:--');
    expect(consoleTime(Number.NaN)).toBe('--:--:--');
    expect(consoleTime(-1)).toBe('--:--:--');
    expect(consoleTime(0)).toHaveLength('12:34:56'.length);
  });
});

describe('buildConsoleView: livelli e conteggi', () => {
  test('«Tutti» non toglie niente e i chip contano per livello', () => {
    const entries = [e('log', 'a'), e('error', 'b'), e('warn', 'c'), e('error', 'd'), e('debug', 'f')];
    const v = buildConsoleView(entries, 'all', '');
    expect(v.rows).toHaveLength(5);
    expect(v.counts).toEqual({ all: 5, error: 2, warn: 1, info: 1, debug: 1 });
  });

  test('il chip «Info+Log» tiene dentro ENTRAMBI i livelli', () => {
    // Sono la stessa cosa per chi guarda: due chip separati direbbero due volte
    // «niente di grave».
    const entries = [e('log', 'uno'), e('info', 'due'), e('debug', 'tre')];
    const v = buildConsoleView(entries, 'info', '');
    expect(v.counts.info).toBe(2);
    expect(v.rows.map((r) => r.text)).toEqual(['uno', 'due']);
  });

  test('scegliere un livello restringe le RIGHE ma non i numeri dei chip', () => {
    // Altrimenti scegliere «Errori» azzererebbe il contatore dei warning, e non
    // ci sarebbe piu' modo di sapere che tornare indietro ha senso.
    const entries = [e('error', 'boom'), e('warn', 'attento'), e('log', 'ciao')];
    const v = buildConsoleView(entries, 'error', '');
    expect(v.rows.map((r) => r.text)).toEqual(['boom']);
    expect(v.counts).toEqual({ all: 3, error: 1, warn: 1, info: 1, debug: 0 });
  });
});

describe('buildConsoleView: ricerca', () => {
  test('non distingue maiuscole e minuscole', () => {
    const entries = [e('error', 'Uncaught TypeError'), e('log', 'tutto bene')];
    expect(buildConsoleView(entries, 'all', 'TYPEERROR').rows.map((r) => r.text)).toEqual(['Uncaught TypeError']);
    expect(buildConsoleView(entries, 'all', 'uncaught').rows.map((r) => r.text)).toEqual(['Uncaught TypeError']);
    expect(buildConsoleView(entries, 'all', 'zzz').rows).toHaveLength(0);
  });

  test('cerca anche nella sorgente, non solo nel testo', () => {
    const entries = [e('log', 'niente qui', { source: 'app.js:42' }), e('log', 'nemmeno qui')];
    expect(buildConsoleView(entries, 'all', 'app.js').rows.map((r) => r.text)).toEqual(['niente qui']);
  });

  test('gli spazi agli estremi non fanno sparire tutto', () => {
    // Un incolla se li porta dietro, e una console che di colpo non trova piu'
    // niente per un carattere invisibile sembra rotta.
    const entries = [e('error', 'boom')];
    expect(buildConsoleView(entries, 'all', '  boom  ').rows).toHaveLength(1);
    // Dentro la stringa invece contano: sono due ricerche diverse.
    expect(buildConsoleView([e('error', 'type error')], 'all', 'typeerror').rows).toHaveLength(0);
  });

  test("i chip contano cio' che la ricerca ha lasciato passare", () => {
    const entries = [e('error', 'fetch fallita'), e('error', 'altro'), e('warn', 'fetch lenta')];
    const v = buildConsoleView(entries, 'all', 'fetch');
    expect(v.counts).toEqual({ all: 2, error: 1, warn: 1, info: 0, debug: 0 });
  });
});

describe('buildConsoleView: raggruppamento', () => {
  test('le voci consecutive identiche diventano una riga con xN', () => {
    const entries = [e('log', 'tick'), e('log', 'tick'), e('log', 'tick'), e('log', 'tock')];
    const rows = buildConsoleView(entries, 'all', '').rows;
    expect(rows.map((r) => [r.text, r.count])).toEqual([['tick', 3], ['tock', 1]]);
  });

  test('stesso testo ma livello diverso NON si fonde', () => {
    const rows = buildConsoleView([e('warn', 'x'), e('error', 'x')], 'all', '').rows;
    expect(rows).toHaveLength(2);
  });

  test('due identiche separate da una TERZA restano due righe', () => {
    const rows = buildConsoleView([e('log', 'a'), e('log', 'b'), e('log', 'a')], 'all', '').rows;
    expect(rows.map((r) => r.text)).toEqual(['a', 'b', 'a']);
  });

  test('separate solo da una riga FILTRATA VIA, invece, si fondono', () => {
    // E' il contratto: il badge conta le ripetizioni che leggeresti una di fila
    // all'altra SULLO SCHERMO, e a schermo quelle due sono consecutive.
    const entries = [e('error', 'boom'), e('log', 'rumore'), e('error', 'boom')];
    const rows = buildConsoleView(entries, 'error', '').rows;
    expect(rows.map((r) => [r.text, r.count])).toEqual([['boom', 2]]);
  });

  test('il gruppo tiene ora, id e sorgente della PRIMA occorrenza', () => {
    const first = e('error', 'boom', { source: 'a.js:1', at: localAt(10, 0, 0) });
    const second = e('error', 'boom', { source: 'b.js:9', at: localAt(10, 0, 5) });
    const [row] = buildConsoleView([first, second], 'all', '').rows;
    expect(row.count).toBe(2);
    expect(row.id).toBe(first.id);
    expect(row.at).toBe(first.at);
    // La chiave del gruppo e' livello + testo: due sorgenti diverse sono lo
    // stesso guasto ripetuto, ed e' quello che si vuole vedere collassato.
    expect(row.source).toBe('a.js:1');
  });

  test('non tocca le voci che gli sono state passate', () => {
    // Il raggruppamento incrementa un contatore su un OGGETTO NUOVO: se
    // scrivesse sulle voci, il buffer del hook cambierebbe sotto React.
    const entries = [e('log', 'tick'), e('log', 'tick')];
    const copy = entries.map((x) => ({ ...x }));
    buildConsoleView(entries, 'all', '');
    expect(entries).toEqual(copy);
  });
});

describe('formatConsoleRows', () => {
  test('una riga per voce, nel formato dichiarato', () => {
    const rows = buildConsoleView(
      [e('error', 'boom', { source: 'app.js:42', at: localAt(16, 3, 9) })],
      'all',
      '',
    ).rows;
    expect(formatConsoleRows(rows)).toBe('16:03:09 [error] boom (app.js:42)');
  });

  test('senza sorgente non restano parentesi vuote', () => {
    const rows = buildConsoleView([e('warn', 'attento', { at: localAt(8, 0, 1) })], 'all', '').rows;
    expect(formatConsoleRows(rows)).toBe('08:00:01 [warn] attento');
  });

  test('il moltiplicatore compare solo da due in su', () => {
    const rows = buildConsoleView(
      [e('log', 'tick', { at: localAt(1, 2, 3) }), e('log', 'tick'), e('log', 'tock', { at: localAt(1, 2, 4) })],
      'all',
      '',
    ).rows;
    expect(formatConsoleRows(rows).split('\n')).toEqual([
      '01:02:03 [log] tick x2',
      '01:02:04 [log] tock',
    ]);
  });

  test("copia solo cio' che si vede: il filtro decide anche gli appunti", () => {
    const entries = [e('error', 'boom', { at: localAt(9, 0, 0) }), e('log', 'rumore', { at: localAt(9, 0, 1) })];
    const rows = buildConsoleView(entries, 'error', '').rows;
    expect(formatConsoleRows(rows)).toBe('09:00:00 [error] boom');
  });

  test('niente da copiare = stringa vuota, non una riga bianca', () => {
    expect(formatConsoleRows([])).toBe('');
  });
});

describe('CONSOLE_FILTERS', () => {
  test('i chip coprono esattamente le chiavi dei conteggi', () => {
    // Un chip senza contatore mostrerebbe `undefined`; un contatore senza chip
    // sarebbe un livello che nessuno puo' selezionare.
    const ids = CONSOLE_FILTERS.map((f) => f.id).sort();
    const keys = Object.keys(buildConsoleView([], 'all', '').counts).sort() as ConsoleFilter[];
    expect(ids).toEqual(keys);
  });

  test("«Tutti» viene per primo: e' lo stato di partenza", () => {
    expect(CONSOLE_FILTERS[0].id).toBe('all');
  });
});
