import { describe, it, expect } from 'bun:test';
import { taskActionErrorMessage } from './taskActionError';

describe('taskActionErrorMessage', () => {
  it('traduce il 409 dei sottotask aperti (la frase del server è per un agente)', () => {
    const raw = new Error('task has open subtasks. Complete or archive them before approving it to done.');
    expect(taskActionErrorMessage(raw)).toBe('Ci sono sottotask aperti: completali o archiviali prima di chiudere il task.');
    // Stessa frase per l'altro gate del server (update a `done`), stesso rimedio.
    expect(taskActionErrorMessage('task has open subtasks. Complete or archive them before marking it done.'))
      .toBe('Ci sono sottotask aperti: completali o archiviali prima di chiudere il task.');
  });

  it('lascia passare gli altri errori come sono', () => {
    expect(taskActionErrorMessage(new Error('checks pre-review rossi'))).toBe('checks pre-review rossi');
  });

  it('senza messaggio usa il fallback del chiamante (mai una banda vuota)', () => {
    expect(taskActionErrorMessage(new Error(''), 'Approva non è riuscito')).toBe('Approva non è riuscito');
    expect(taskActionErrorMessage(null, 'Approva non è riuscito')).toBe('Approva non è riuscito');
    expect(taskActionErrorMessage(undefined)).toBe('azione non riuscita');
  });
});
