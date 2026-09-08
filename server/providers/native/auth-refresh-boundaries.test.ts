/** @covers MP-AUTH-01 */
/** Refresh contention and timeouts use only fake credentials in child fixtures. */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OAUTH_REFRESH_TIMEOUT_MS } from './auth';

async function runFixture(mode: 'locked' | 'rotated' | 'network-timeout') {
  const root = mkdtempSync(join(tmpdir(), 'topics-auth-boundary-'));
  mkdirSync(join(root, '.claude'));
  const credentialPath = join(root, '.claude', '.credentials.json');
  const fixture = join(root, 'fixture.ts');
  writeFileSync(credentialPath, JSON.stringify({ claudeAiOauth: {
    accessToken: 'fake-expired', refreshToken: 'fake-refresh', expiresAt: Date.now() - 60_000,
  } }));
  writeFileSync(fixture, `
    import { existsSync, readFileSync, writeFileSync } from 'fs';
    import { getAccessToken } from ${JSON.stringify(join(import.meta.dir, 'auth.ts'))};
    const credentialPath = ${JSON.stringify(credentialPath)};
    const mode = ${JSON.stringify(mode)};
    let requests = 0;
    let timeoutMs = 0;
    const lock = credentialPath + '.lock';
    if (mode !== 'network-timeout') {
      // Accelerate only the fixture's clock. The other owner's lock stays
      // fresh throughout the wait and cannot be mistaken for abandoned work.
      const start = Date.now();
      writeFileSync(lock, JSON.stringify({ pid: 123456, at: start + 1_000_000 }));
      let ticks = 0;
      Date.now = () => start + ++ticks * 1000;
      globalThis.fetch = async () => { requests++; throw new Error('MUST_NOT_REFRESH'); };
      if (mode === 'rotated') setTimeout(() => writeFileSync(credentialPath, JSON.stringify({ claudeAiOauth: {
        accessToken: 'fake-rotated', refreshToken: 'fake-rotated-refresh', expiresAt: start + 3_600_000,
      } })), 0);
    } else {
      AbortSignal.timeout = (ms) => {
        timeoutMs = ms;
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException('Fixture timed out', 'TimeoutError')), 1);
        return controller.signal;
      };
      globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
        requests++;
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    }
    let token = null;
    let error = null;
    try { token = await getAccessToken(); } catch (failure) { error = failure.message; }
    console.log(JSON.stringify({ token, error, requests, timeoutMs, locked: existsSync(lock),
      credential: JSON.parse(readFileSync(credentialPath, 'utf8')).claudeAiOauth.accessToken }));
  `);
  try {
    const child = Bun.spawn([process.execPath, fixture], {
      // Isolation applies only to this disposable child. The test process and
      // the live server retain their own homes and never expose a real token.
      env: { ...process.env, HOME: root, NODE_ENV: 'test', TOPICS_CREDENTIALS_KEYCHAIN: '0' },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    return JSON.parse(stdout.trim()) as {
      token: string | null; error: string | null; requests: number; timeoutMs: number;
      locked: boolean; credential: string;
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('OAuth refresh ownership and request deadline', () => {
  test('lock timeout never refreshes or releases the other owner lock', async () => {
    const result = await runFixture('locked');
    expect(result.error).toContain('OAUTH_REFRESH_LOCK_TIMEOUT');
    expect(result.requests).toBe(0);
    expect(result.locked).toBe(true);
    expect(result.credential).toBe('fake-expired');
  });

  test('a renewal completed while waiting is reused even if the lock wait times out', async () => {
    const result = await runFixture('rotated');
    expect(result.error).toBeNull();
    expect(result.token).toBe('fake-rotated');
    expect(result.requests).toBe(0);
    expect(result.locked).toBe(true);
  });

  test('a stalled OAuth request aborts before the lock can become stale and releases its own lock', async () => {
    const result = await runFixture('network-timeout');
    expect(result.error).toContain('Fixture timed out');
    expect(result.requests).toBe(1);
    expect(result.timeoutMs).toBe(OAUTH_REFRESH_TIMEOUT_MS);
    expect(result.timeoutMs).toBeGreaterThan(0);
    expect(result.timeoutMs).toBeLessThan(30_000);
    expect(result.locked).toBe(false);
    expect(result.credential).toBe('fake-expired');
  });
});
