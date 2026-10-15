import { describe, it, expect } from 'bun:test';
import { groupLiveTerminals, liveTerminalDetail, liveTerminalLabel, type LiveTerminal } from './liveTerminals';

const row = (id: string, source: LiveTerminal['source'], extra: Partial<LiveTerminal> = {}): LiveTerminal => ({
  id, source, title: '', command: null, cwd: null, tty: null, busy: null, ...extra,
});

describe('groupLiveTerminals', () => {
  it('un ramo per origine, Topics prima, le origini vuote non hanno ramo', () => {
    const g = groupLiveTerminals([row('tmux:%1', 'tmux'), row('topics:a', 'topics'), row('tmux:%2', 'tmux')]);
    expect(g.map((x) => [x.source, x.rows.map((r) => r.id)])).toEqual([
      ['topics', ['topics:a']],
      ['tmux', ['tmux:%1', 'tmux:%2']],
    ]);
  });
});

describe('etichette', () => {
  it('il titolo, poi il programma, poi l’id', () => {
    expect(liveTerminalLabel(row('x', 'tmux', { title: '  ', command: 'claude' }))).toBe('claude');
    expect(liveTerminalLabel(row('tmux:%1', 'tmux'))).toBe('tmux:%1');
  });
  it('programma · ultima cartella', () => {
    expect(liveTerminalDetail(row('x', 'terminal', { command: 'claude', cwd: '/Users/a/Projects/topics' }))).toBe('claude · topics');
    expect(liveTerminalDetail(row('x', 'terminal', { cwd: '/' }))).toBe('/');
  });
});
