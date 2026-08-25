/**
 * Whether a task still has a live agent session behind it, whether its tab can
 * be opened, and when the absence has to be explained rather than hidden.
 *
 * @covers KANBAN-07
 */
import { describe, expect, test } from 'bun:test';
import {
  canOpenTaskSession,
  shouldExplainMissingSession,
  taskSessionState,
} from './taskSession';

const KNOWN = new Set(['topic-a', 'topic-b']);

describe('taskSessionState', () => {
  test('nessun assignedTopicId: il task non è mai stato dispatchato', () => {
    expect(taskSessionState(null, KNOWN)).toBe('never');
    expect(taskSessionState(undefined, KNOWN)).toBe('never');
    expect(taskSessionState('', KNOWN)).toBe('never');
  });

  test('il topic è nell’indice: la sessione è viva', () => {
    expect(taskSessionState('topic-a', KNOWN)).toBe('alive');
  });

  test('indice pieno e topic assente: la sessione non c’è più', () => {
    expect(taskSessionState('topic-morto', KNOWN)).toBe('gone');
  });

  // L'invariante che questo file esiste per proteggere: al boot l'indice dei
  // topic è vuoto, e un vuoto NON è una morte (vedi hooks/rosterTrust.ts).
  // Confonderli spegnerebbe "apri la sessione" su ogni task della board finché
  // l'indice non arriva — cioè proprio mentre l'agente lavora.
  test('indice VUOTO: non lo sappiamo, e non si dichiara morta', () => {
    expect(taskSessionState('topic-a', new Set())).toBe('unknown');
    expect(taskSessionState('topic-mai-visto', new Set())).toBe('unknown');
  });

  test('un topic archiviato che è ancora nell’indice resta vivo', () => {
    // Archiviato ≠ morto: aprirlo lo riapre (modello a due stati, openPanel).
    // Questo test dice che il chiamante deve passare anche gli archiviati.
    expect(taskSessionState('topic-b', new Set(['topic-b']))).toBe('alive');
  });
});

describe('canOpenTaskSession', () => {
  test('viva e sconosciuta passano, mai-dispatchata e morta no', () => {
    expect(canOpenTaskSession('alive')).toBe(true);
    expect(canOpenTaskSession('unknown')).toBe(true);
    expect(canOpenTaskSession('never')).toBe(false);
    expect(canOpenTaskSession('gone')).toBe(false);
  });
});

describe('shouldExplainMissingSession', () => {
  test('solo «gone» merita una spiegazione: è l’unico caso in cui c’era', () => {
    expect(shouldExplainMissingSession('gone')).toBe(true);
    expect(shouldExplainMissingSession('never')).toBe(false);
    expect(shouldExplainMissingSession('alive')).toBe(false);
    expect(shouldExplainMissingSession('unknown')).toBe(false);
  });
});
