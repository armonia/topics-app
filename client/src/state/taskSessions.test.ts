/**
 * @covers KANBAN-56
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import {
  __resetTaskSessions,
  applyTaskSessionIndex,
  getTopicTask,
  subscribeTopicTask,
  type TopicTaskRef,
} from './taskSessions';

const ref = (over: Partial<TopicTaskRef> = {}): TopicTaskRef => ({
  taskId: 'task-1',
  text: 'Scheda e sessione',
  status: 'in_progress',
  dispatchState: 'working',
  ...over,
});

beforeEach(() => __resetTaskSessions());

describe('applyTaskSessionIndex', () => {
  test('un topic ignoto non ha task, uno indicizzato sì', () => {
    expect(getTopicTask('topic-a')).toBeUndefined();
    applyTaskSessionIndex({ 'topic-a': ref() });
    expect(getTopicTask('topic-a')?.taskId).toBe('task-1');
  });

  // Sostituzione, non fusione: un task che perde l'assignedTopicId (o che viene
  // archiviato) sparisce dal feed, e fondendo la riga di ritorno resterebbe a
  // puntare per sempre a una scheda che non c'è.
  test('un topic che esce dal feed esce dall’indice', () => {
    applyTaskSessionIndex({ 'topic-a': ref(), 'topic-b': ref({ taskId: 'task-2' }) });
    applyTaskSessionIndex({ 'topic-b': ref({ taskId: 'task-2' }) });
    expect(getTopicTask('topic-a')).toBeUndefined();
    expect(getTopicTask('topic-b')?.taskId).toBe('task-2');
  });

  test('un aggiornamento identico NON sveglia gli iscritti né cambia identità', () => {
    applyTaskSessionIndex({ 'topic-a': ref() });
    const before = getTopicTask('topic-a');
    let woken = 0;
    subscribeTopicTask('topic-a', () => { woken += 1; });
    // Il feed si rilegge a ogni evento `task:*` — a raffica durante un dispatch —
    // e ogni rilettura produce oggetti NUOVI ma quasi sempre uguali.
    applyTaskSessionIndex({ 'topic-a': ref() });
    expect(woken).toBe(0);
    expect(getTopicTask('topic-a')).toBe(before!);
  });

  test('un cambiamento vero sveglia solo il topic che è cambiato', () => {
    applyTaskSessionIndex({ 'topic-a': ref(), 'topic-b': ref({ taskId: 'task-2' }) });
    let wokenA = 0;
    let wokenB = 0;
    subscribeTopicTask('topic-a', () => { wokenA += 1; });
    subscribeTopicTask('topic-b', () => { wokenB += 1; });
    applyTaskSessionIndex({
      'topic-a': ref({ status: 'review' }),
      'topic-b': ref({ taskId: 'task-2' }),
    });
    expect(wokenA).toBe(1);
    expect(wokenB).toBe(0);
    expect(getTopicTask('topic-a')?.status).toBe('review');
  });

  test('anche la SPARIZIONE sveglia: la riga di ritorno deve poter smettere', () => {
    applyTaskSessionIndex({ 'topic-a': ref() });
    let woken = 0;
    subscribeTopicTask('topic-a', () => { woken += 1; });
    applyTaskSessionIndex({});
    expect(woken).toBe(1);
    expect(getTopicTask('topic-a')).toBeUndefined();
  });

  test('disiscriversi ferma i risvegli', () => {
    let woken = 0;
    const off = subscribeTopicTask('topic-a', () => { woken += 1; });
    off();
    applyTaskSessionIndex({ 'topic-a': ref() });
    expect(woken).toBe(0);
  });
});
