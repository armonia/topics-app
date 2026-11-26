/** @covers AGENTS-NAV-01 */
import { describe, expect, test } from 'bun:test';
import { modelName, splitTurnTitle } from './displayNames';

describe('modelName', () => {
  test('a model id reads as its human name', () => {
    expect(modelName('claude-sonnet-5-5')).toBe('Sonnet 5.5');
    expect(modelName('anthropic/claude-opus-5-5')).toBe('Opus 5.5');
  });
  test('a name with no version is left alone', () => {
    expect(modelName('claude-cli')).toBe('claude-cli');
  });
});

describe('splitTurnTitle', () => {
  test('a thread title puts the thread first and the channel beside it', () => {
    expect(splitTurnTitle('#zeno-development > Migrazione siti')).toEqual({ title: 'Migrazione siti', channel: '#zeno-development' });
    expect(splitTurnTitle('#pm-jarvis › one')).toEqual({ title: 'one', channel: '#pm-jarvis' });
  });
  test('a plain chat title has no channel part', () => {
    expect(splitTurnTitle('#operazioni')).toEqual({ title: '#operazioni', channel: null });
  });
});
