/**
 * The server's 409s translated for a human: open subtasks block the close, and
 * Stop with no agent behind it. Never an empty error band.
 *
 * @covers KANBAN-07, KANBAN-08
 */
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

  it('traduce il 409 di «Ferma» senza agente, e dice come rimettere in moto la card', () => {
    const detto = taskActionErrorMessage(new Error('no active agent on this task'));
    expect(detto).not.toMatch(/no active agent/i);
    expect(detto).toMatch(/niente da fermare/);
    expect(detto).toMatch(/Todo/);
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
