/** @covers AGPT-04 */
import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

test('native classification passes its model and bounded abort through to the HTTP request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-completion-deadline-'));
  mkdirSync(join(root, '.claude'));
  writeFileSync(join(root, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: {
    accessToken: 'fake-fresh', refreshToken: 'fake-refresh', expiresAt: Date.now() + 3_600_000,
  } }));
  const fixture = join(root, 'fixture.ts');
  writeFileSync(fixture, `
    import { NativeProvider } from ${JSON.stringify(join(import.meta.dir, 'provider.ts'))};
    let calls = 0, aborted = false, model = null;
    globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
      calls++; model = JSON.parse(options.body).model;
      const abort = () => { aborted = true; reject(options.signal.reason); };
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    });
    const provider = new NativeProvider({ type: 'native', defaultWorkspace: ${JSON.stringify(root)} });
    try { await provider.complete([{role:'user', content:'classify'}], {model:'claude-haiku-4-5', reasoningEffort:'low', timeoutMs:100}); }
    catch { /* The bounded request is expected to abort. */ }
    console.log(JSON.stringify({calls, aborted, model}));
  `);
  try {
    const child = Bun.spawn([process.execPath, fixture], {
      env: { ...process.env, HOME: root, NODE_ENV: 'test', TOPICS_CREDENTIALS_KEYCHAIN: '0' }, stdout: 'pipe', stderr: 'pipe',
    });
    const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, error).toBe(0);
    const result = JSON.parse(out.trim().split('\n').at(-1)!);
    expect(result).toEqual({ calls: 1, aborted: true, model: 'claude-haiku-4-5' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
