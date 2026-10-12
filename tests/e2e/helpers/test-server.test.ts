import { describe, expect, it } from 'bun:test';
import { existsSync } from 'fs';
import { join } from 'path';
import { webkit } from '@playwright/test';
import {
  dataDirForPort,
  resolveChromiumPath,
  resolvePlaywrightBrowsersPath,
  testServerEnv,
} from './test-server';

/** @covers MUSE-01 */
describe('testServerEnv XDG isolation', () => {
  it('pins XDG_CONFIG_HOME and XDG_DATA_HOME inside the isolated home', () => {
    const home = join(dataDirForPort(13399), '.home');
    const env = testServerEnv(13399);
    expect(env.XDG_CONFIG_HOME).toBe(join(home, '.config'));
    expect(env.XDG_DATA_HOME).toBe(join(home, '.local', 'share'));
  });

  it('does not inherit the outer XDG variables', () => {
    const prevConfig = process.env.XDG_CONFIG_HOME;
    const prevData = process.env.XDG_DATA_HOME;
    process.env.XDG_CONFIG_HOME = '/outer/config';
    process.env.XDG_DATA_HOME = '/outer/share';
    try {
      const env = testServerEnv(13398);
      expect(env.XDG_CONFIG_HOME).not.toContain('/outer/');
      expect(env.XDG_DATA_HOME).not.toContain('/outer/');
    } finally {
      if (prevConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevConfig;
      if (prevData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevData;
    }
  });
});

/** @covers KANBAN-95 */
describe('testServerEnv server browsers', () => {
  it('points PLAYWRIGHT_BROWSERS_PATH at the same cache the runner sees', () => {
    // start-test-server.sh isolates HOME, so without this the server looks
    // for its own WebKit (card previews) in an empty `<DATA_DIR>/.home`
    // cache. A restarted server lost it and every post-restart preview
    // screenshot failed (RECAPTURE-01 red only after a restart in the job).
    let runnerCache = '';
    try {
      const executable = webkit.executablePath();
      runnerCache = join(executable, '..', '..');
    } catch { /* no browser installed here */ }
    const env = testServerEnv(13397);
    if (!runnerCache) {
      expect(env.PLAYWRIGHT_BROWSERS_PATH ?? '').toBe('');
      return;
    }
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(runnerCache);
    expect(resolvePlaywrightBrowsersPath()).toBe(runnerCache);
  });

  it('pins CHROMIUM_PATH to an existing binary or leaves it empty', () => {
    const env = testServerEnv(13396);
    const chromium = env.CHROMIUM_PATH ?? '';
    expect(chromium).toBe(resolveChromiumPath());
    if (chromium) expect(existsSync(chromium)).toBe(true);
  });
});
