/** @covers MACHINE-02 */
import { describe, expect, it } from 'bun:test';
import { hasClaudeSessionSignal } from './claude-session-signal';

describe('hasClaudeSessionSignal', () => {
  it('accepts the OAuth token of a fresh node with no HOME and no ~/.claude', () => {
    expect(hasClaudeSessionSignal({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, { exists: () => false, home: () => '' })).toBe(true);
  });

  it('falls back to the OS home when HOME is unset', () => {
    const seen: string[] = [];
    const ok = hasClaudeSessionSignal({}, { home: () => '/srv/node', exists: p => { seen.push(p); return p.endsWith('.claude'); } });
    expect(ok).toBe(true);
    expect(seen[0]).toContain('srv');
  });

  it('is false with no key, no token and no config directory', () => {
    expect(hasClaudeSessionSignal({}, { exists: () => false, home: () => '/srv/node' })).toBe(false);
  });
});
