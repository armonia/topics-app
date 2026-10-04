/**
 * Which closes ask before stopping another session's work (SUBAGENT-20).
 * @covers SUBAGENT-20
 */
import { describe, expect, test } from 'bun:test';
import { chatStopTarget, parentLabel, stopConfirmOptions, terminalStopTarget } from './subagentStopGuard';
import type { TerminalSessionInfo, Topic } from '../types';

const term = (over: Partial<TerminalSessionInfo>): TerminalSessionInfo => ({
  id: 't1', name: 'arte-tappa-1', createdAt: '', cwd: '/p', command: 'claude', clients: 0, type: 'claude-code', ...over,
} as TerminalSessionInfo);
const label = (key: string) => `[${key}]`;

describe('terminalStopTarget', () => {
  test('a sub-agent still working asks, naming who started it', () => {
    expect(terminalStopTarget(term({ parentSessionKey: 'topic:pop', subAgentPhase: 'working' }), label))
      .toEqual({ name: 'arte-tappa-1', startedBy: '[topic:pop]' });
    expect(terminalStopTarget(term({ parentSessionKey: 'topic:pop', subAgentPhase: 'waiting-prompt' }), label)).not.toBeNull();
    // No phase read yet: the busy PTY decides.
    expect(terminalStopTarget(term({ parentSessionKey: 'topic:pop', subAgentPhase: null, busy: true }), label)).not.toBeNull();
  });

  test('a finished sub-agent closes without a question, even with its PTY alive', () => {
    expect(terminalStopTarget(term({ parentSessionKey: 'topic:pop', subAgentPhase: 'finished', busy: true }), label)).toBeNull();
    expect(terminalStopTarget(term({ parentSessionKey: 'topic:pop', busy: false }), label)).toBeNull();
  });

  test('a terminal the person opened never asks, busy or not', () => {
    expect(terminalStopTarget(term({ busy: true }), label)).toBeNull();
    expect(terminalStopTarget(undefined, label)).toBeNull();
  });
});

describe('chatStopTarget', () => {
  test('only a native sub-agent whose turn is streaming', () => {
    expect(chatStopTarget({ name: 'voci', subagentOf: 'topic:pop' }, true, label)).toEqual({ name: 'voci', startedBy: '[topic:pop]' });
    expect(chatStopTarget({ name: 'voci', subagentOf: 'topic:pop' }, false, label)).toBeNull();
    expect(chatStopTarget({ name: 'mine' }, true, label)).toBeNull();
  });
});

describe('parentLabel and the dialog', () => {
  test('the parent is named by its chat, then its terminal, then its key', () => {
    const topics = { a: { sessionKey: 'topic:pop', name: 'Remake Prince of Persia' } as Topic };
    expect(parentLabel('topic:pop', topics, [])).toBe('«Remake Prince of Persia»');
    expect(parentLabel('t9', topics, [term({ id: 't9', name: 'zsh' })])).toBe('«zsh»');
    expect(parentLabel('topic:gone', topics, [])).toBe('topic:gone');
  });

  test('the dialog says who started it and what stopping does', () => {
    const tr = (key: string, vars?: Record<string, string | number>) => `${key}|${JSON.stringify(vars ?? {})}`;
    const o = stopConfirmOptions({ name: 'arte', startedBy: '«pop»' }, tr);
    expect(o.title).toContain('subagent.stopConfirm.title');
    expect(String(o.body)).toContain('«pop»');
    expect(String(o.body)).toContain('«arte»');
    expect(o.tone).toBe('danger');
  });
});
