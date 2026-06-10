import { describe, it, expect } from 'bun:test';
import {
  normalizeTerminalAgent,
  buildTerminalSessionBody,
  TERMINAL_AGENT_LABELS,
} from './terminalAgents';

describe('normalizeTerminalAgent', () => {
  it('passes known agent types through', () => {
    expect(normalizeTerminalAgent('claude-code')).toBe('claude-code');
    expect(normalizeTerminalAgent('codex')).toBe('codex');
    expect(normalizeTerminalAgent('shell')).toBe('shell');
  });

  it('falls back to shell for absent / unknown subTypes (server parity)', () => {
    expect(normalizeTerminalAgent(undefined)).toBe('shell');
    expect(normalizeTerminalAgent('')).toBe('shell');
    expect(normalizeTerminalAgent('claude-code-team')).toBe('shell');
    expect(normalizeTerminalAgent('garbage')).toBe('shell');
  });
});

describe('buildTerminalSessionBody', () => {
  it('builds the default claude body (backward-compatible shape)', () => {
    expect(buildTerminalSessionBody('claude-code', { skipPermissions: true })).toEqual({
      type: 'claude-code',
      name: 'Claude Code',
      skipPermissions: true,
    });
  });

  it('builds a codex body without claude-only flags', () => {
    expect(buildTerminalSessionBody('codex', { skipPermissions: true })).toEqual({
      type: 'codex',
      name: 'Codex',
    });
  });

  it('builds a shell body without claude-only flags', () => {
    expect(buildTerminalSessionBody('shell', { skipPermissions: false })).toEqual({
      type: 'shell',
      name: 'Shell',
    });
  });

  it('threads cwd when provided (project-scoped spawn)', () => {
    expect(buildTerminalSessionBody('codex', { cwd: '/tmp/proj' })).toEqual({
      type: 'codex',
      name: 'Codex',
      cwd: '/tmp/proj',
    });
  });

  it('omits skipPermissions when undefined (server default applies)', () => {
    expect(buildTerminalSessionBody('claude-code')).toEqual({
      type: 'claude-code',
      name: 'Claude Code',
    });
  });

  it('labels stay in sync with the agent union', () => {
    expect(Object.keys(TERMINAL_AGENT_LABELS).sort()).toEqual(['claude-code', 'codex', 'shell']);
  });
});
