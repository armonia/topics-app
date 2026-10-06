import { describe, expect, it } from 'bun:test';
import { join } from 'path';
import { dataDirForPort, testServerEnv } from './test-server';

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
