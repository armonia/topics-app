import { describe, expect, test } from 'bun:test';
import { agentSetupRows } from './agentSetupRows';

describe('agentSetupRows', () => {
  test('keeps found paths and missing install commands for display', () => {
    expect(agentSetupRows([
      { id: 'claude', name: 'Claude Code', path: '/usr/local/bin/claude', installed: true, install: 'npm i -g claude-code', url: '', manualPath: null, manualPathBroken: false, bin: 'claude' },
      { id: 'codex', name: 'Codex', path: null, installed: false, install: 'npm i -g @openai/codex', url: '', manualPath: null, manualPathBroken: false, bin: 'codex' },
    ])).toEqual([
      { id: 'claude', name: 'Claude Code', installed: true, path: '/usr/local/bin/claude', install: 'npm i -g claude-code' },
      { id: 'codex', name: 'Codex', installed: false, path: null, install: 'npm i -g @openai/codex' },
    ]);
  });
});
