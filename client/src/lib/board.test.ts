import { test, expect, describe } from 'bun:test';
import { boardIdForPath, TASK_STATUSES, parseQuestionBlock } from './board';

describe('boardIdForPath', () => {
  // Parity lock with the server (services/tasks.ts:projectIdForPath). Must stay
  // byte-identical or the client would address a different board than the API.
  test('exact output matches the server algorithm', () => {
    expect(boardIdForPath('/x/proj')).toBe('proj-xwac8t');
  });
  test('basename prefix + deterministic', () => {
    const a = boardIdForPath('/Users/zorahrel/Projects/topics-app');
    expect(a).toBe(boardIdForPath('/Users/zorahrel/Projects/topics-app'));
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
