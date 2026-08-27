/**
 * Normalising the agent a terminal session runs, and the body that opens it.
 *
 * @covers TERM-01
 */
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
    // `type` resta `shell` (l'id: CHECK di SQLite, testid E2E, protocollo col
    // server) e il `name` e' la LABEL user-facing — le due cose non sono la
    // stessa, ed e' proprio qui che si vede.
    expect(buildTerminalSessionBody('shell', { skipPermissions: false })).toEqual({
      type: 'shell',
      name: 'Terminale',
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
    expect(Object.keys(TERMINAL_AGENT_LABELS).sort()).toEqual(['claude-code', 'codex', 'kimi-code', 'opencode', 'shell']);
  });
});
