import { describe, expect, test } from 'bun:test';
import { CircleX, GitPullRequest, MessageCircleQuestion, MessageSquare, PauseCircle, Server, SquareCheck, TerminalSquare } from 'lucide-react';
import { historyRowIcon, historyTitle } from './historyGlyph';

describe('historyRowIcon: the icon comes from the kind, not from an emoji', () => {
  test('each server kind has its own glyph', () => {
    expect(historyRowIcon({ kind: 'task-review', groupKey: 'task:t1', targetKind: 'task' })).toBe(GitPullRequest);
    expect(historyRowIcon({ kind: 'task-parked', groupKey: 'task:t1', targetKind: 'task' })).toBe(PauseCircle);
    expect(historyRowIcon({ kind: 'chat-error', groupKey: 'topic:a', targetKind: 'topic' })).toBe(CircleX);
    expect(historyRowIcon({ kind: 'session', groupKey: 'topic:a', targetKind: 'topic' })).toBe(MessageCircleQuestion);
    expect(historyRowIcon({ kind: 'chat-message', groupKey: 'topic:a', targetKind: 'topic' })).toBe(MessageSquare);
    expect(historyRowIcon({ kind: 'system', groupKey: null, targetKind: null })).toBe(Server);
  });

  test('a terminal subject stays a terminal, whatever the kind', () => {
    expect(historyRowIcon({ kind: 'session', groupKey: 'terminal:x', targetKind: null })).toBe(TerminalSquare);
    expect(historyRowIcon({ kind: 'terminal', groupKey: null, targetKind: null })).toBe(TerminalSquare);
  });

  test('an unmapped kind falls back on the target', () => {
    expect(historyRowIcon({ kind: 'approval', groupKey: null, targetKind: 'task' })).toBe(SquareCheck);
    expect(historyRowIcon({ kind: 'other', groupKey: null, targetKind: null })).toBe(MessageSquare);
  });
});

describe('historyTitle: older rows lose their leading emoji on read', () => {
  test.each([
    ['\u{1F4CB} Task pronto per la review', 'Task pronto per la review'],
    ['⛔️ Task non consegnato', 'Task non consegnato'],
    ['⚠️ Rifai la migration', 'Rifai la migration'],
    ['\u{1F4AC} #patto', '#patto'],
    ['Task da sistemare', 'Task da sistemare'],
  ])('%s', (raw, words) => {
    expect(historyTitle(raw)).toBe(words);
  });

  test('a title made only of an emoji is kept rather than emptied', () => {
    expect(historyTitle('\u{1F4AC}')).toBe('\u{1F4AC}');
  });
});
