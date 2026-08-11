/**
 * `attemptStat` — il diffstat di un tentativo del fan-out, tradotto.
 *
 * Il fatto che vale la pena provare è UNO: in italiano deve rendere byte per
 * byte quello che rendeva `formatAttemptStat` (shared/task-attempt.ts), che è
 * rimasto al suo posto perché lo usa il server per scrivere il confronto nel
 * thread. Sono due copie della stessa forma su due lati che non possono
 * condividere il dizionario, e una copia che diverge in silenzio è il modo in
 * cui il commento nel thread e la riga sullo schermo iniziano a raccontare due
 * cose diverse dello stesso tentativo — più le spec e2e che ancorano l'italiano
 * («1 file», «3 file»).
 *
 * L'inglese si prova a parte, perché lì il plurale esiste davvero.
 */
import { describe, test, expect } from 'bun:test';
import { attemptStat, taskCopyText } from './format';
import { formatAttemptStat } from '../../../../shared/task-attempt';
import { t } from '../../lib/i18n';
import type { TaskAttempt } from '../../lib/board';

const it = (key: string, vars?: Record<string, string | number>) => t(key, 'it', vars);
const en = (key: string, vars?: Record<string, string | number>) => t(key, 'en', vars);

function attempt(over: Partial<TaskAttempt> = {}): TaskAttempt {
  return {
    id: 'a1', taskId: 't1', idx: 1, topicId: 'top1', worktreeId: null, branch: 'task/wt-a',
    state: 'delivered', commit: 'aaa111', filesChanged: 3, insertions: 120, deletions: 8,
    summary: null, error: null, startedAt: null, endedAt: null,
    ...over,
  } as TaskAttempt;
}

describe('attemptStat', () => {
  test('in italiano rende esattamente quello che rendeva la versione condivisa', () => {
    const cases = [
      attempt(),
      attempt({ filesChanged: 1, insertions: 2, deletions: 0 }),
      attempt({ state: 'running', commit: null, filesChanged: null }),
      attempt({ commit: null, filesChanged: null }),
      attempt({ commit: null, filesChanged: null, state: 'failed', error: 'timeout' }),
    ];
    for (const a of cases) expect(attemptStat(a, it)).toBe(formatAttemptStat(a));
  });

  test("in inglese «file» prende la s solo quando i file sono più d'uno", () => {
    expect(attemptStat(attempt({ filesChanged: 1, insertions: 2, deletions: 0 }), en)).toBe('1 file · +2 −0');
    expect(attemptStat(attempt(), en)).toBe('3 files · +120 −8');
  });

  test('gli stati senza diffstat hanno comunque una parola in inglese', () => {
    expect(attemptStat(attempt({ state: 'running', commit: null, filesChanged: null }), en)).toBe('running…');
    expect(attemptStat(attempt({ commit: null, filesChanged: null }), en)).toBe('no changes');
    expect(attemptStat(attempt({ commit: null, filesChanged: null, state: 'failed', error: 'timeout' }), en))
      .toBe('no changes — timeout');
  });
});

describe('taskCopyText', () => {
  test('titolo e descrizione separati da una riga vuota', () => {
    expect(taskCopyText({ text: 'Rifare la scheda prodotto', description: 'Foto nuove e prezzo in alto.' }))
      .toBe('Rifare la scheda prodotto\n\nFoto nuove e prezzo in alto.');
  });

  test('senza descrizione si copia il titolo, senza righe vuote in coda', () => {
    expect(taskCopyText({ text: 'Rifare la scheda prodotto', description: null })).toBe('Rifare la scheda prodotto');
    expect(taskCopyText({ text: 'Rifare la scheda prodotto' })).toBe('Rifare la scheda prodotto');
    expect(taskCopyText({ text: 'Rifare la scheda prodotto', description: '   \n  ' })).toBe('Rifare la scheda prodotto');
  });

  test('gli spazi ai bordi non finiscono negli appunti', () => {
    expect(taskCopyText({ text: '  Titolo  ', description: '\n  corpo\n\n' })).toBe('Titolo\n\ncorpo');
  });
});
