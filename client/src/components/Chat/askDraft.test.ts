/**
 * @covers ASK-07
 */
import { beforeEach, afterAll, describe, expect, test } from 'bun:test';
import { clearAskDraft, isEmptyDraft, readAskDraft, sweepAskDrafts, writeAskDraft } from './askDraft';

/** localStorage finto: bun:test gira senza DOM. */
class MemStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

const store = new MemStorage();
// @ts-expect-error — ambiente di test: si monta il minimo che il modulo legge.
globalThis.window = { localStorage: store };

beforeEach(() => store.clear());

// window is a PARTIAL fake (localStorage only): leaving it behind lets a later
// file of the same sharded process pass its `typeof window === 'undefined'`
// guard and then blow up on getComputedStyle & co. Restore the pre-file state
// (no ambient window under bun).
afterAll(() => {
  delete (globalThis as { window?: unknown }).window;
});

const T0 = 1_800_000_000_000;

describe('bozza del pannello di risposta', () => {
  test('quello che scrivi si ritrova dopo un ricaricamento', () => {
    writeAskDraft('call-1', { selections: { 'Quale?': ['B'] }, otherText: { 'Quale?': 'una mia idea' }, step: 1 }, T0);
    expect(readAskDraft('call-1', T0)).toEqual({
      selections: { 'Quale?': ['B'] },
      otherText: { 'Quale?': 'una mia idea' },
      step: 1,
    });
  });

  test('la bozza è per DOMANDA, non per sessione', () => {
    // Nella stessa sessione si susseguono domande diverse: la risposta a metà
    // dell'una non deve ricomparire sotto l'altra.
    writeAskDraft('call-1', { text: 'per la prima' }, T0);
    expect(readAskDraft('call-2', T0)).toBeNull();
  });

  test('rispondere cancella la bozza', () => {
    writeAskDraft('call-1', { text: 'quasi pronto' }, T0);
    clearAskDraft('call-1');
    expect(readAskDraft('call-1', T0)).toBeNull();
  });

  test('svuotare tutto cancella invece di lasciare un record vuoto', () => {
    writeAskDraft('call-1', { text: 'ci ripenso' }, T0);
    writeAskDraft('call-1', { selections: { q: [] }, otherText: { q: '  ' }, text: '', step: 2 }, T0);
    expect(readAskDraft('call-1', T0)).toBeNull();
  });

  test('una bozza vecchia non riappare mesi dopo sotto una domanda nuova', () => {
    writeAskDraft('call-1', { text: 'vecchia' }, T0);
    expect(readAskDraft('call-1', T0 + 8 * 24 * 3600_000)).toBeNull();
  });

  test('contenuto corrotto non rompe il pannello', () => {
    store.setItem('topics:ask-draft:call-1', '{non json');
    expect(readAskDraft('call-1', T0)).toBeNull();
  });

  test('la pulizia toglie le scadute e lascia le vive', () => {
    writeAskDraft('vecchia', { text: 'x' }, T0 - 8 * 24 * 3600_000);
    writeAskDraft('viva', { text: 'y' }, T0);
    expect(sweepAskDrafts(T0)).toBe(1);
    expect(readAskDraft('viva', T0)).not.toBeNull();
    expect(readAskDraft('vecchia', T0)).toBeNull();
  });

  test('isEmptyDraft: `step` da solo non è una risposta a metà', () => {
    expect(isEmptyDraft({ step: 3 })).toBe(true);
    expect(isEmptyDraft({ step: 3, selections: { q: ['A'] } })).toBe(false);
    expect(isEmptyDraft({ values: { nome: 'x' } })).toBe(false);
    expect(isEmptyDraft({ jsonText: '{"a":1}' })).toBe(false);
  });
});

/**
 * The correction to a plan is a draft like every other one.
 *
 * @covers ASK-07, PERM-09
 */
describe('la correzione al piano', () => {
  beforeEach(() => store.clear());

  test('sopravvive alla chiusura del pannello, sotto la sua domanda', () => {
    writeAskDraft('call-plan', { planText: '# Piano\n\n1. Passo corretto' }, T0);
    expect(readAskDraft('call-plan', T0)?.planText).toBe('# Piano\n\n1. Passo corretto');
    // PER QUESTION: the correction of one plan never shows under another.
    expect(readAskDraft('call-altro', T0)).toBeNull();
  });

  test('conta come bozza: da sola basta a farla salvare', () => {
    expect(isEmptyDraft({ planText: '# Piano corretto' })).toBe(false);
    expect(isEmptyDraft({ planText: '   ' })).toBe(true);
  });

  test('scade come le altre, e rispondere la cancella', () => {
    writeAskDraft('call-plan', { planText: 'corretto' }, T0);
    expect(readAskDraft('call-plan', T0 + 8 * 24 * 3600_000)).toBeNull();
    writeAskDraft('call-plan', { planText: 'corretto' }, T0);
    clearAskDraft('call-plan');
    expect(readAskDraft('call-plan', T0)).toBeNull();
  });
});
