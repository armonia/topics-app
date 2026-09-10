/** @covers AGPT-04 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { _resetCodexBinCache } from '../lib/codex-bin';
import { CodexProvider } from './codex';
import { ClaudeCodeProvider } from './claude-code';

const previousBin = process.env.CODEX_BIN;
const previousClaudeBin = process.env.TOPICS_CLAUDE_CLI_PATH;
let root: string;
let marker: string;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-complete-test-')));
  marker = join(root, 'process.json');
  const native = join(root, 'fake-native.js');
  writeFileSync(native, `await Bun.write(${JSON.stringify(marker)}, JSON.stringify({cwd:process.cwd(),pid:process.pid,wrapper:process.ppid})); setInterval(() => {}, 1000);`);
  const binary = join(root, 'fake-codex');
  writeFileSync(binary, `#!${process.execPath}
import { spawn } from 'node:child_process';
if (process.argv.includes('--version')) { console.log('1.0.0'); process.exit(0); }
const input = await Bun.stdin.text();
const result = { cwd: process.cwd(), argv: process.argv.slice(2), pid: process.pid };
if (input === 'hang') { await Bun.write(${JSON.stringify(marker)}, JSON.stringify(result)); setInterval(() => {}, 1000); }
else if (input === 'wrapper') { spawn(process.execPath, [${JSON.stringify(native)}], { stdio: 'inherit' }); }
else console.log(JSON.stringify(process.argv.includes('--print') ? {result:JSON.stringify(result)} : result));
`, { mode: 0o700 });
  process.env.CODEX_BIN = binary;
  process.env.TOPICS_CLAUDE_CLI_PATH = binary;
  _resetCodexBinCache();
});
afterAll(() => {
  if (previousBin === undefined) delete process.env.CODEX_BIN;
  else process.env.CODEX_BIN = previousBin;
  if (previousClaudeBin === undefined) delete process.env.TOPICS_CLAUDE_CLI_PATH;
  else process.env.TOPICS_CLAUDE_CLI_PATH = previousClaudeBin;
  _resetCodexBinCache();
  rmSync(root, { recursive: true, force: true });
});

describe('Codex completion with a fake executable', () => {
  test('per-call model and effort reach isolated argv without mutating defaults', async () => {
    const provider = new CodexProvider({ type: 'codex', model: 'configured-model', defaultWorkspace: root });
    const result = await provider.complete([{ role: 'user', content: 'classify' }], { model: 'gpt-5.6-luna', reasoningEffort: 'low', isolated: true, timeoutMs: 2000 });
    const run = JSON.parse(result.content ?? '');
    expect(run.argv).toEqual(['exec', '--model', 'gpt-5.6-luna', '-c', 'model_reasoning_effort="low"', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only', '-c', 'features.shell_tool=false', '-c', 'web_search="disabled"']);
    expect(run.cwd).not.toBe(root);
    expect(existsSync(run.cwd)).toBe(false);
    const regular = JSON.parse((await provider.complete([{ role: 'user', content: 'normal' }])).content ?? '');
    expect(regular.argv).toEqual(['exec', '--model', 'configured-model']);
    expect(regular.cwd).toBe(root);
  });

  test('timeout kills the classifier before rejecting and removes its scratch directory', async () => {
    const provider = new CodexProvider({ type: 'codex', defaultWorkspace: root });
    const started = Date.now();
    await expect(provider.complete([{ role: 'user', content: 'hang' }], { isolated: true, timeoutMs: 2000 })).rejects.toThrow('timed out');
    const run = JSON.parse(readFileSync(marker, 'utf8'));
    expect(Date.now() - started).toBeLessThan(4500);
    expect(() => process.kill(run.pid, 0)).toThrow();
    expect(existsSync(run.cwd)).toBe(false);
  });

  test('timeout also kills a wrapper native child holding inherited output pipes', async () => {
    const provider = new CodexProvider({ type: 'codex', defaultWorkspace: root });
    const started = Date.now();
    await expect(provider.complete([{ role: 'user', content: 'wrapper' }], { isolated: true, timeoutMs: 2000 })).rejects.toThrow('timed out');
    const run = JSON.parse(readFileSync(marker, 'utf8'));
    expect(Date.now() - started).toBeLessThan(4500);
    expect(() => process.kill(run.wrapper, 0)).toThrow();
    expect(() => process.kill(run.pid, 0)).toThrow();
    expect(existsSync(run.cwd)).toBe(false);
  });

  test('Claude classification honors per-call model/effort and has no enabled tools', async () => {
    const provider = new ClaudeCodeProvider({ type: 'claude-code', defaultWorkspace: root });
    const result = await provider.complete([{ role: 'user', content: 'classify' }], { model: 'claude-haiku-4-5', reasoningEffort: 'low', timeoutMs: 3000 });
    const run = JSON.parse(result.content ?? '');
    expect(run.argv).toContain('claude-haiku-4-5');
    expect(run.argv).toContain('--effort');
    expect(run.argv[run.argv.indexOf('--effort') + 1]).toBe('low');
    expect(run.argv[run.argv.indexOf('--tools') + 1]).toBe('');
  });

  test('Claude one-shot timeout also closes the wrapper process tree', async () => {
    const provider = new ClaudeCodeProvider({ type: 'claude-code', defaultWorkspace: root });
    await expect(provider.complete([{ role: 'user', content: 'wrapper' }], { timeoutMs: 2000 })).rejects.toThrow('timed out');
    const run = JSON.parse(readFileSync(marker, 'utf8'));
    expect(() => process.kill(run.wrapper, 0)).toThrow();
    expect(() => process.kill(run.pid, 0)).toThrow();
  });
});
