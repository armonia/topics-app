/**
 * @covers TERM-01, TERM-09
 *
 * Intentional PTY endings need a reason and a caller in the server log. The
 * bridge exit line then tells whether its own kill path requested the signal.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatTerminalKillLog } from './terminal-kill';

const ROUTES = readFileSync(resolve(import.meta.dir, '../routes/terminal.ts'), 'utf8');
const BRIDGE = readFileSync(resolve(import.meta.dir, '../pty-bridge.mjs'), 'utf8');
const SERVER = readFileSync(resolve(import.meta.dir, '../../server.ts'), 'utf8');

function killMessages(): string[] {
  return ROUTES.split('\n')
    .filter((line) => line.includes('sendTerminalKill(') && !line.includes('function sendTerminalKill'))
    .map((line) => line.match(/sendTerminalKill\(([^;]+)\);/)?.[1] ?? '');
}

describe('terminal PTY kill diagnostics', () => {
  test('every bridge kill message names a reason and caller', () => {
    const messages = killMessages();
    expect(messages.length).toBe(8);
    const directBridgeKills = [...ROUTES.matchAll(/sendToBridge\(\{\s*type:\s*["']kill["']/g)];
    expect(directBridgeKills.length).toBe(1);
    for (const args of messages) {
      expect(args).toMatch(/^\s*[^,]+,\s*(?:['"][a-z-]+['"]|[A-Za-z_$][\w$]*),\s*[^,]+$/);
    }
  });

  test('the centralized kill helper emits one line and reconcile has no duplicate', () => {
    expect(ROUTES.match(/console\.log\(formatTerminalKillLog\(/g)?.length).toBe(1);
    expect(ROUTES).toContain('console.log(formatTerminalKillLog({ sessionId: id, reason, caller }));');
    expect(ROUTES).not.toContain('Killing orphaned bridge session');
  });

  test('retirement sweeps are attributed to the sweep, not a user close', () => {
    expect(ROUTES).toContain("ending === 'swept' ? 'retirement-sweep' : 'user-close'");
    expect(ROUTES).toContain('caller: string =');
    expect(SERVER).toContain("retireTerminalSession(id, \"swept\", \"orphan-child-sweep\")");
  });

  test('the bridge reports exit code, signal, and whether it requested the kill', () => {
    expect(BRIDGE).toContain("[PTY Bridge] exit ${id.slice(0, 8)} exitCode=${exitCode} signal=${signal ?? 'none'} ");
  });

  test('bridge probe and shutdown kills identify their reason and caller', () => {
    expect(BRIDGE.includes("reason: 'probe-cleanup', caller: 'bridge-probe'")).toBe(true);
    expect(BRIDGE.includes("s.killReason = 'bridge-shutdown'")).toBe(true);
    expect(BRIDGE.includes('caller=shutdown:${signal}')).toBe(true);
  });

  test('only resumable dormant rows receive the dormant websocket verdict', () => {
    expect(ROUTES.includes('if (dormant && resumable) ws.close(TERMINAL_WS_CLOSE_DORMANT')).toBe(true);
    expect(ROUTES.includes('const restingVerdict = canResume && !reloading')).toBe(true);
  });

  test('formats one compact line with the id, reason, and caller', () => {
    expect(formatTerminalKillLog({
      sessionId: '12345678-aaaa-bbbb-cccc-dddddddddddd',
      reason: 'park',
      caller: 'idle-reaper',
    })).toBe('[Terminal] kill 12345678 reason=park caller=idle-reaper');
  });
});
