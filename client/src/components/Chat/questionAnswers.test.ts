import { describe, expect, test } from 'bun:test';
import { readAnsweredQuestions, readElicitationAnswer, readRecommendation, splitAnswer } from './questionAnswers';

describe('splitAnswer', () => {
  test('a single choice is the option, without the recommended word', () => {
    expect(splitAnswer('Bun (Recommended)', ['Bun (Recommended)', 'Node'], false)).toEqual([{ text: 'Bun', free: false }]);
  });

  test('single select: free text with commas stays one free answer, never option plus comment', () => {
    expect(splitAnswer('Postgres, ma con pgvector', ['Postgres', 'SQLite'], false)).toEqual([
      { text: 'Postgres, ma con pgvector', free: true },
    ]);
  });

  test('multi select: options and free text in the order given, the free text keeps its commas', () => {
    expect(splitAnswer('Lint, controlla anche i test, per favore, Build', ['Lint', 'Build', 'Deploy'], true)).toEqual([
      { text: 'Lint', free: false },
      { text: 'controlla anche i test, per favore', free: true },
      { text: 'Build', free: false },
    ]);
  });

  test('multi select: a label that itself contains the separator wins over its pieces', () => {
    expect(splitAnswer('Rosso, verde, Blu', ['Rosso', 'Rosso, verde', 'Blu'], true)).toEqual([
      { text: 'Rosso, verde', free: false },
      { text: 'Blu', free: false },
    ]);
  });

  test('an empty answer has no parts', () => {
    expect(splitAnswer('  ', ['A'], false)).toEqual([]);
  });
});

describe('readAnsweredQuestions', () => {
  test('pairs every question with its own answer and marks the chosen options', () => {
    const out = readAnsweredQuestions(
      [
        { question: 'Runtime?', header: 'Runtime', options: [{ label: 'Bun' }, { label: 'Node' }] },
        { question: 'Checks?', options: [{ label: 'Lint' }, { label: 'Build' }], multiSelect: true },
      ],
      { 'Runtime?': 'Node', 'Checks?': 'Lint, Build' },
    );
    expect(out).toEqual([
      { question: 'Runtime?', header: 'Runtime', options: [{ label: 'Bun', chosen: false }, { label: 'Node', chosen: true }], parts: [{ text: 'Node', free: false }] },
      { question: 'Checks?', options: [{ label: 'Lint', chosen: true }, { label: 'Build', chosen: true }], parts: [{ text: 'Lint', free: false }, { text: 'Build', free: false }] },
    ]);
  });

  test('options as plain strings (the detail of an old row) work the same', () => {
    const [q] = readAnsweredQuestions([{ question: 'DB?', options: ['Postgres', 'SQLite'] }], { 'DB?': 'SQLite' });
    expect(q!.options).toEqual([{ label: 'Postgres', chosen: false }, { label: 'SQLite', chosen: true }]);
  });

  test('an answer to a question the row does not know is kept, as free text', () => {
    expect(readAnsweredQuestions([], { 'Quale strada?': 'la seconda' })).toEqual([
      { question: 'Quale strada?', options: [], parts: [{ text: 'la seconda', free: true }] },
    ]);
  });
});

test('readRecommendation reads the field and the word, and strips the word from the label', () => {
  expect(readRecommendation({ label: 'Bun (consigliato)' })).toEqual({ isRecommended: true, label: 'Bun' });
  expect(readRecommendation({ label: 'Node', recommended: true })).toEqual({ isRecommended: true, label: 'Node' });
  expect(readRecommendation({ label: 'Deno' })).toEqual({ isRecommended: false, label: 'Deno' });
});

describe('readElicitationAnswer', () => {
  const schema = {
    type: 'object',
    properties: { confirm: { type: 'boolean', title: 'Confirm' }, title: { type: 'string', title: 'Title' }, labels: { type: 'string' } },
    required: ['title'],
  };

  test('one field per property, named by its title, in the order the form asked', () => {
    expect(readElicitationAnswer(schema, 'Create the issue?', { title: 'Fix the login bug', confirm: true })).toEqual({
      message: 'Create the issue?',
      fields: [{ label: 'Confirm', value: true }, { label: 'Title', value: 'Fix the login bug' }],
    });
  });

  test('no title: the key; a field the schema does not know: after the known ones; empty: left out', () => {
    expect(readElicitationAnswer(schema, undefined, { extra: 3, labels: 'bug', title: '  ' }).fields).toEqual([
      { label: 'labels', value: 'bug' },
      { label: 'extra', value: 3 },
    ]);
  });

  test('never JSON: a nested object is spelled out, a list stays a list, a bare value has no label', () => {
    expect(readElicitationAnswer({}, '', { repo: { owner: 'armonia', private: false }, tags: ['a', 'b'] })).toEqual({
      fields: [
        { label: 'repo › owner', value: 'armonia' },
        { label: 'repo › private', value: false },
        { label: 'tags', value: ['a', 'b'] },
      ],
    });
    expect(readElicitationAnswer(undefined, undefined, 'yes please').fields).toEqual([{ value: 'yes please' }]);
    expect(readElicitationAnswer(schema, undefined, null).fields).toEqual([]);
  });
});
