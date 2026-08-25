/**
 * comment-author.test.ts — the label behind `task_comments.author`.
 *
 * Every case below is a REAL value read from the live board on 13/08/2026, not
 * an invented one. The 60-character sentences are the defect this module was
 * written for: 404 distinct authors on that board were topic names, and a topic
 * name for a dispatched agent is the task title cut at 60 characters.
  * @covers CAUTHOR-01
 */
import { describe, test, expect } from 'bun:test';
import {
  commentAuthorLabel,
  AGENT_AUTHOR,
  AGENT_AUTHOR_PREFIX,
  AUTHOR_NAME_MAX_CHARS,
  AUTHOR_NAME_MAX_WORDS,
} from './comment-author';

/** The exact row that opened the case: card 8b458c6b, cut mid-word at 60. */
const CUT_TITLE = 'Girare la barra viva della soglia di compattazione: due brac';

describe('commentAuthorLabel — roles', () => {
  test('the four reserved roles stay themselves, and carry their kind', () => {
    for (const role of ['user', 'system', 'dispatcher', 'verifier'] as const) {
      const got = commentAuthorLabel(role);
      expect(got.label).toBe(role);
      expect(got.kind).toBe(role);
      expect(got.derived).toBe(false);
    }
  });

  test('a role is matched after trimming and case-folding, and comes back canonical', () => {
    expect(commentAuthorLabel('  System ').label).toBe('system');
    expect(commentAuthorLabel('USER').kind).toBe('user');
    // Canonical means the stored spelling is not what gets printed.
    expect(commentAuthorLabel('USER').derived).toBe(true);
  });

  test('a bare "agent" is the generic agent, with no id', () => {
    const got = commentAuthorLabel(AGENT_AUTHOR);
    expect(got.label).toBe('agent');
    expect(got.kind).toBe('agent');
    expect(got.agentId).toBe(null);
  });
});

describe('commentAuthorLabel — agent:<id>', () => {
  const AUTHOR = `${AGENT_AUTHOR_PREFIX}f2847a1c-9d31-4a6e-b0c7-51e2a8d4f903`;

  test('an agent id becomes a readable short id, and the full id survives', () => {
    const got = commentAuthorLabel(AUTHOR);
    expect(got.kind).toBe('agent');
    expect(got.label).toBe('agent f2847a1c');
    expect(got.agentId).toBe('f2847a1c-9d31-4a6e-b0c7-51e2a8d4f903');
    expect(got.derived).toBe(true);
  });

  test('the label never carries the full 36-character id', () => {
    expect(commentAuthorLabel(AUTHOR).label.length).toBeLessThanOrEqual(AUTHOR_NAME_MAX_CHARS);
  });

  test('the terminal-tab form (a 16-char session slice) resolves too', () => {
    const got = commentAuthorLabel(`${AGENT_AUTHOR_PREFIX}9a3f01bc4d7e2f55`);
    expect(got.label).toBe('agent 9a3f01bc');
    expect(got.agentId).toBe('9a3f01bc4d7e2f55');
  });

  test('two different agents on the same task do not collapse into one label', () => {
    const a = commentAuthorLabel(`${AGENT_AUTHOR_PREFIX}9260871e-780f-474d-9bf6-ff0de59dac3a`);
    const b = commentAuthorLabel(`${AGENT_AUTHOR_PREFIX}eb73c57b-7041-4b88-9d50-1ac4df62791e`);
    expect(a.label).not.toBe(b.label);
  });

  test('the prefix with nothing after it is the generic agent, not "agent "', () => {
    const got = commentAuthorLabel(AGENT_AUTHOR_PREFIX);
    expect(got.label).toBe('agent');
    expect(got.agentId).toBe(null);
  });
});

describe('commentAuthorLabel — the 404 stored topic names', () => {
  test('THE case: a title cut mid-word is not a name, so it reads as the agent', () => {
    const got = commentAuthorLabel(CUT_TITLE);
    expect(got.kind).toBe('agent');
    expect(got.label).toBe('agent');
    expect(got.derived).toBe(true);
    // The point of the whole module: the half word never reaches a person.
    expect(got.label).not.toContain('brac');
  });

  test('sentence-shaped authors from the live board all read as the agent', () => {
    const stored = [
      'Girare la barra viva della soglia di compattazione: due brac',
      'A session-scoped Stop hook is now active with condition: "andiamoci ad assicurar',
      'Aggiungi una pagina /changelog che legga CHANGELOG.md e la r',
      'Memoria: aggiungere modifica (edit) — cancellazione già funz',
      'Aggiungi filtri sulla board Kanban',
      'Verifica attività aperte su Dancerooms',
      'Link invito Cifra settato male',
      'i18n e unit test Fase 2',
      'installa wegolo se utile',
    ];
    for (const raw of stored) {
      const got = commentAuthorLabel(raw);
      expect(got.label).toBe(AGENT_AUTHOR);
      expect(got.derived).toBe(true);
    }
  });

  test('a name-shaped author is kept, because throwing it away would lose a real name', () => {
    for (const raw of ['Claude Code', 'native-browser-pane-web', 'claude', 'agent-1', 'Test']) {
      const got = commentAuthorLabel(raw);
      expect(got.label).toBe(raw);
      expect(got.kind).toBe('agent');
      expect(got.derived).toBe(false);
    }
  });

  test('the two thresholds are the whole rule, and each one alone decides', () => {
    // Short enough but too many words: a phrase, not a name.
    const manyWords = 'a b c d';
    expect(manyWords.length).toBeLessThanOrEqual(AUTHOR_NAME_MAX_CHARS);
    expect(manyWords.split(' ').length).toBeGreaterThan(AUTHOR_NAME_MAX_WORDS);
    expect(commentAuthorLabel(manyWords).label).toBe(AGENT_AUTHOR);

    // One word, but longer than a name slot: a run-on, not a name.
    const oneLongWord = 'x'.repeat(AUTHOR_NAME_MAX_CHARS + 1);
    expect(commentAuthorLabel(oneLongWord).label).toBe(AGENT_AUTHOR);

    // Exactly at both limits: still a name. The boundary is inclusive.
    const atLimit = 'ab cd '.repeat(0) + 'ab cd ef';
    expect(atLimit.split(' ').length).toBe(AUTHOR_NAME_MAX_WORDS);
    expect(commentAuthorLabel(atLimit).label).toBe(atLimit);
    expect(commentAuthorLabel('y'.repeat(AUTHOR_NAME_MAX_CHARS)).derived).toBe(false);
  });

  test('a multi-line author is never a name, however short', () => {
    expect(commentAuthorLabel('ok\nno').label).toBe(AGENT_AUTHOR);
  });

  test('collapsed whitespace does not turn a phrase into a name', () => {
    // Four words separated by runs of spaces: the word count is what decides,
    // not how many blanks sit between them.
    expect(commentAuthorLabel('a   b   c   d').label).toBe(AGENT_AUTHOR);
    // And a name padded with blanks comes back trimmed, not rejected.
    expect(commentAuthorLabel('  verifica  ').label).toBe('verifica');
  });

  test('an empty or blank author is the agent, never an empty label', () => {
    for (const raw of ['', '   ', '\n']) {
      const got = commentAuthorLabel(raw);
      expect(got.label).toBe(AGENT_AUTHOR);
      expect(got.kind).toBe('agent');
    }
  });

  test('a non-string author does not crash the card', () => {
    expect(commentAuthorLabel(undefined).label).toBe(AGENT_AUTHOR);
    expect(commentAuthorLabel(null).label).toBe(AGENT_AUTHOR);
  });

  test('no label is ever longer than a name slot', () => {
    const everything = [
      CUT_TITLE, 'user', 'system', 'dispatcher', 'verifier', 'agent', 'Claude Code', '',
      `${AGENT_AUTHOR_PREFIX}f2847a1c-9d31-4a6e-b0c7-51e2a8d4f903`,
    ];
    for (const raw of everything) {
      expect(commentAuthorLabel(raw).label.length).toBeLessThanOrEqual(AUTHOR_NAME_MAX_CHARS);
      expect(commentAuthorLabel(raw).label.trim()).toBe(commentAuthorLabel(raw).label);
      expect(commentAuthorLabel(raw).label.length).toBeGreaterThan(0);
    }
  });
});

describe('commentAuthorLabel — kind', () => {
  test('separates the board roles from anything that speaks for an agent', () => {
    expect(commentAuthorLabel('user').kind).toBe('user');
    expect(commentAuthorLabel('system').kind).toBe('system');
    expect(commentAuthorLabel('dispatcher').kind).toBe('dispatcher');
    expect(commentAuthorLabel('verifier').kind).toBe('verifier');
    // Everything else speaks for an agent, whatever the stored string looks like.
    expect(commentAuthorLabel(CUT_TITLE).kind).toBe('agent');
    expect(commentAuthorLabel(`${AGENT_AUTHOR_PREFIX}f2847a1c`).kind).toBe('agent');
    expect(commentAuthorLabel('claude').kind).toBe('agent');
    expect(commentAuthorLabel('').kind).toBe('agent');
  });
});
