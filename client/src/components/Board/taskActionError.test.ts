/**
 * The server's 409s translated for a human: open subtasks block the close, and
 * Stop with no agent behind it. Never an empty error band.
 *
 * @covers KANBAN-07, KANBAN-08
 */
import { describe, it, expect } from 'bun:test';
import { taskActionErrorMessage } from './taskActionError';
import { t } from '../../lib/i18n';

/** The Italian catalogue, as the board reads it: the sentences below are the ones a person sees. */
const tr = (key: string, vars?: Record<string, string | number>) => t(key, 'it', vars);

describe('taskActionErrorMessage', () => {
  it('traduce il 409 dei sottotask aperti (la frase del server è per un agente)', () => {
    const raw = new Error('task has open subtasks. Complete or archive them before approving it to done.');
    expect(taskActionErrorMessage(raw, tr)).toBe('Ci sono sottotask aperti: completali o archiviali prima di chiudere il task.');
    // Stessa frase per l'altro gate del server (update a `done`), stesso rimedio.
    expect(taskActionErrorMessage('task has open subtasks. Complete or archive them before marking it done.', tr))
      .toBe('Ci sono sottotask aperti: completali o archiviali prima di chiudere il task.');
  });

  it('traduce il 409 di «Ferma» senza agente, e dice come rimettere in moto la card', () => {
    const detto = taskActionErrorMessage(new Error('no active agent on this task'), tr);
    expect(detto).not.toMatch(/no active agent/i);
    expect(detto).toMatch(/niente da fermare/);
    expect(detto).toMatch(/Todo/);
  });

  it('traduce il 409 dei checks rossi senza mettere in faccia un campo dell\'API', () => {
    // The server's sentence is written for an API caller: its remedy is
    // `force: true`, which a card cannot pass. The check's name stays (it says
    // what to look at); the JSON field and the timestamp do not.
    const detto = taskActionErrorMessage(new Error(
      'i checks pre-review sono ROSSI (`lint`). La strada normale e\' rimandarlo all\'agent; '
      + 'per accettarlo comunque usa il bottone «comunque» della card.',
    ), tr);
    expect(detto).not.toMatch(/force/i);
    expect(detto).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(detto).toMatch(/lint/);
    expect(detto).toMatch(/comunque/);
  });

  it('lascia passare gli altri errori come sono', () => {
    expect(taskActionErrorMessage(new Error('worktree sporco'), tr)).toBe('worktree sporco');
  });

  it('senza messaggio usa il fallback del chiamante (mai una banda vuota)', () => {
    expect(taskActionErrorMessage(new Error(''), tr, 'Approva non è riuscito')).toBe('Approva non è riuscito');
    expect(taskActionErrorMessage(null, tr, 'Approva non è riuscito')).toBe('Approva non è riuscito');
    expect(taskActionErrorMessage(undefined, tr)).toBe('azione non riuscita');
  });
});
