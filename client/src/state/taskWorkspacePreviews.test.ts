/**
 * taskWorkspacePreviews.test — chi ha aperto quelle pane, e quindi chi le
 * richiude. Il contratto è «automatico si richiude, a mano resta»: qui si
 * verifica la metà automatica (registrazione, uscita, tetto) e che un task mai
 * registrato — cioè aperto col bottone — non restituisca niente da chiudere.
  * @covers KANBAN-55
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import {
  noteAutoOpenedPreview,
  releaseAutoOpenedPreview,
  autoOpenedPreviewOf,
  __resetAutoOpenedPreviews,
  MAX_AUTO_OPENED_TASKS,
} from './taskWorkspacePreviews';

beforeEach(() => __resetAutoOpenedPreviews());

describe('registrazione e uscita', () => {
  test('uscire dal task restituisce le sue pane e dimentica la voce', () => {
    expect(noteAutoOpenedPreview('t1', '/p', ['a_ws', 'b_ws'])).toEqual([]);
    expect(autoOpenedPreviewOf('t1')).toEqual(['a_ws', 'b_ws']);
    expect(releaseAutoOpenedPreview('t1')).toEqual(['a_ws', 'b_ws']);
    expect(releaseAutoOpenedPreview('t1')).toEqual([]);
    expect(autoOpenedPreviewOf('t1')).toEqual([]);
  });

  test('un task mai registrato (aperto A MANO) non ha niente da chiudere', () => {
    expect(releaseAutoOpenedPreview('mai-visto')).toEqual([]);
  });

  test('registrare a vuoto non crea una voce', () => {
    expect(noteAutoOpenedPreview('t1', '/p', [])).toEqual([]);
    expect(noteAutoOpenedPreview('', '/p', ['a'])).toEqual([]);
    expect(autoOpenedPreviewOf('t1')).toEqual([]);
  });

  test('ri-registrare lo stesso task aggiorna il manifesto e non sfratta se stesso', () => {
    noteAutoOpenedPreview('t1', '/p', ['a_ws']);
    expect(noteAutoOpenedPreview('t1', '/p', ['a_ws', 'b_ws'])).toEqual([]);
    expect(autoOpenedPreviewOf('t1')).toEqual(['a_ws', 'b_ws']);
  });

  test('i contextId doppi si contano una volta sola', () => {
    noteAutoOpenedPreview('t1', '/p', ['a_ws', 'a_ws']);
    expect(autoOpenedPreviewOf('t1')).toEqual(['a_ws']);
  });
});

describe('tetto', () => {
  test(`oltre ${MAX_AUTO_OPENED_TASKS} task, sfratta il più vecchio e ne torna le pane`, () => {
    noteAutoOpenedPreview('t1', '/p', ['a_ws']);
    noteAutoOpenedPreview('t2', '/p', ['b_ws']);
    expect(noteAutoOpenedPreview('t3', '/p', ['c_ws'])).toEqual(['a_ws']);
    expect(autoOpenedPreviewOf('t1')).toEqual([]);
    expect(autoOpenedPreviewOf('t2')).toEqual(['b_ws']);
    expect(autoOpenedPreviewOf('t3')).toEqual(['c_ws']);
  });

  test('ri-registrare il più vecchio lo riporta in cima: sfratta l\'altro', () => {
    noteAutoOpenedPreview('t1', '/p', ['a_ws']);
    noteAutoOpenedPreview('t2', '/p', ['b_ws']);
    noteAutoOpenedPreview('t1', '/p', ['a_ws']); // t1 torna il più recente
    expect(noteAutoOpenedPreview('t3', '/p', ['c_ws'])).toEqual(['b_ws']);
  });
});
