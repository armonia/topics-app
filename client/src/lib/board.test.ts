import { test, expect, describe } from 'bun:test';
import { blockedByChip, reopenedChip, boardIdForPath, TASK_STATUSES, parseQuestionBlock, type BoardTask } from './board';

describe('boardIdForPath', () => {
  // Parity lock with the server (services/tasks.ts:projectIdForPath). Must stay
  // byte-identical or the client would address a different board than the API.
  test('exact output matches the server algorithm', () => {
    expect(boardIdForPath('/x/proj')).toBe('proj-xwac8t');
  });
  test('basename prefix + deterministic', () => {
    const a = boardIdForPath('/Users/utente/Projects/topics-app');
    expect(a).toBe(boardIdForPath('/Users/utente/Projects/topics-app'));
    expect(a.startsWith('topics-app-')).toBe(true);
  });
});

describe('TASK_STATUSES', () => {
  test('the five board columns in order', () => {
    expect(TASK_STATUSES).toEqual(['backlog', 'todo', 'in_progress', 'review', 'done']);
  });
});

describe('parseQuestionBlock', () => {
  test('parses a question with options', () => {
    const text = 'Un commento.\n\n```question\nQuale approccio auth?\n- JWT in cookie httpOnly\n- Bearer token breve\n```';
    expect(parseQuestionBlock(text)).toEqual({
      question: 'Quale approccio auth?',
      options: ['JWT in cookie httpOnly', 'Bearer token breve'],
    });
  });

  test('parses a question with no options (free-text only)', () => {
    expect(parseQuestionBlock('```question\nCome procedo?\n```')).toEqual({ question: 'Come procedo?', options: [] });
  });

  test('accepts * bullets and trims whitespace', () => {
    expect(parseQuestionBlock('```question\n  Scegli:\n  * A\n  * B\n```')).toEqual({ question: 'Scegli:', options: ['A', 'B'] });
  });

  test('returns null without a question block', () => {
    expect(parseQuestionBlock('solo un commento')).toBeNull();
    expect(parseQuestionBlock('')).toBeNull();
    expect(parseQuestionBlock('```\nnot a question fence\n```')).toBeNull();
  });

  test('returns null when the block has only options, no question', () => {
    expect(parseQuestionBlock('```question\n- A\n- B\n```')).toBeNull();
  });

  // The canonical form is server-composed (tasks service `questionOptions`),
  // but the parser must stay tolerant of hand-written LLM variants.
  test('parses the exact server-composed canonical form', () => {
    const text = '```question\nQuale approccio uso?\n- JWT in cookie\n- Bearer token\n```';
    expect(parseQuestionBlock(text)).toEqual({
      question: 'Quale approccio uso?',
      options: ['JWT in cookie', 'Bearer token'],
    });
  });

  test('tolerates CRLF newlines', () => {
    const text = '```question\r\nScelta?\r\n- A\r\n- B\r\n```';
    expect(parseQuestionBlock(text)).toEqual({ question: 'Scelta?', options: ['A', 'B'] });
  });

  test('tolerates a degenerate single-line block (lost newlines)', () => {
    const text = '```question Il task non ha descrizione: cosa faccio? - È un test - Va compilata```';
    expect(parseQuestionBlock(text)).toEqual({
      question: 'Il task non ha descrizione: cosa faccio?',
      options: ['È un test', 'Va compilata'],
    });
  });

  test('single-line block without options is a plain question', () => {
    expect(parseQuestionBlock('```question Come procedo?```')).toEqual({ question: 'Come procedo?', options: [] });
  });
});

describe('blockedByChip', () => {
  const chip = (over: Partial<BoardTask> = {}) =>
    blockedByChip({ blockedByTaskId: 'blk', blockedBy: null, ...over } as BoardTask);

  test('nessun link, nessun chip', () => {
    expect(chip({ blockedByTaskId: null })).toBeNull();
  });

  test('bloccante risolto: il titolo finisce nel chip', () => {
    expect(chip({ blockedBy: { id: 'blk', text: 'Rifai la scheda', status: 'todo', archived: false } }))
      .toEqual({ label: 'in attesa di: Rifai la scheda', title: 'In attesa di: Rifai la scheda' });
  });

  // Il caso per cui esiste tutto questo: il bloccante non è nella lista fetchata
  // (sottotask, altro progetto, archiviato) e il server non ha potuto risolverlo.
  // Prima il chip spariva e la card sembrava libera; ora resta, degradato.
  test('titolo mancante: il chip resta, con il testo degradato', () => {
    const c = chip({ blockedBy: null });
    expect(c?.label).toBe('in attesa di un altro task');
    expect(c?.title).toContain('non parte finché');
  });

  test('bloccante done: muto (il dispatcher lo farebbe partire)', () => {
    expect(chip({ blockedBy: { id: 'blk', text: 'Fatto', status: 'done', archived: false } })).toBeNull();
  });

  test('bloccante archiviato: muto', () => {
    expect(chip({ blockedBy: { id: 'blk', text: 'Archiviato', status: 'todo', archived: true } })).toBeNull();
  });
});

describe('reopenedChip', () => {
  const chip = (over: Partial<BoardTask> = {}) =>
    reopenedChip({ reopenedAt: null, reopenedBy: null, reopenedActor: null, ...over } as BoardTask);

  test('mai uscita da done: nessun chip', () => {
    expect(chip()).toBeNull();
  });

  test('riaperta da un agent: il chip lo dice, e dice CHI', () => {
    const c = chip({ reopenedAt: '2026-08-11T09:30:00.000Z', reopenedBy: 'claude', reopenedActor: 'agent' });
    expect(c?.label).toBe('riaperta');
    expect(c?.title).toContain('agent');
    expect(c?.title).toContain('claude');
    // `detail` è la frase per la banda del drawer, che ha già «Riaperta» in
    // grassetto: se ripetesse il preambolo del tooltip sarebbe illeggibile.
    expect(c?.detail).toContain('agent');
    expect(c?.detail).not.toContain('Riaperta');
    expect(c?.detail).not.toContain('Era in Done');
  });

  test('riaperta dall’umano o dal sistema: stesso chip, autore diverso', () => {
    expect(chip({ reopenedAt: '2026-08-11T09:30:00.000Z', reopenedActor: 'human' })?.title).toContain('da te');
    expect(chip({ reopenedAt: '2026-08-11T09:30:00.000Z', reopenedActor: 'system' })?.title).toContain('dal sistema');
  });

  test('data illeggibile: il chip resta (non è il timestamp a doverlo tenere in piedi)', () => {
    const c = chip({ reopenedAt: 'non-una-data', reopenedActor: 'agent' });
    expect(c?.label).toBe('riaperta');
    expect(c?.title).toContain('non-una-data');
  });
});
