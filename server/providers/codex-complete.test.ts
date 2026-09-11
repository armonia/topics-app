/** @covers AGPT-04 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { _resetCodexBinCache } from '../lib/codex-bin';
import { CodexProvider, KILL_GRACE_MS } from './codex';
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

/**
 * Has the process gone? WAIT for it - do not look one instant later.
 *
 * `process.kill(pid, 0)` that does not throw means "still alive". These cases
 * checked that ONCE, right after the timeout had asked the tree to die: but
 * asking is synchronous and dying is not, and the kernel reaps when it reaps.
 * On an idle machine that happens within a microsecond and the test is green by
 * luck; with twelve check runs in parallel the same line falls over - measured
 * 2026-09-11 on two different cards (392e95ae and 6133a8e8), always on this
 * case, always `expect(received).toThrow()` while the timeout upstream had
 * fired correctly.
 *
 * This is NOT a widened tolerance: if the process never dies, this still goes
 * red when the budget runs out. What changes is the claim - "it died", not "it
 * had already died at that instant".
 *
 * THE BUDGET IS DERIVED, and the first version of this helper got it wrong by
 * guessing. The provider does not kill on the timeout: it sends SIGTERM and
 * waits `KILL_GRACE_MS` (3 s) before SIGKILL, so after `timeoutMs: 2000` the
 * child is LEGITIMATELY alive for three more seconds. A hardcoded 3000 ms
 * budget therefore expired at the exact instant the kill was sent - marginal by
 * construction, green or red by luck. Reading the constant keeps the two in
 * step if the grace period ever moves.
 *
 * The mechanism underneath, named precisely: SIGKILL is delivered immediately,
 * but the OS may take a few milliseconds to reap the zombie before
 * `process.kill(pid, 0)` stops throwing ESRCH. That is what the +2 s covers.
 * (Diagnosis of the grace period: card 36dc7819, which reproduced it 4/4 in
 * isolation and showed it is deterministic, not a load flake as I had assumed.)
 */
async function expectGone(pid: number, budgetMs = KILL_GRACE_MS + 2_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // gone - which is what we wanted
    }
    if (Date.now() >= deadline) throw new Error(`pid ${pid} is still alive after ${budgetMs}ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * The budget for the cases where the timeout is NOT what is being measured.
 *
 * Three cases here WANT the timeout to fire, and there a small number is the
 * subject: `timeoutMs: 2000` is the claim. The two argv cases want the opposite
 * - the fake executable has to finish - and they were carrying 2000 and 3000 ms
 * as if it made no difference. It does, because the budget has to cover a
 * process spawn, and a spawn is the first thing a loaded machine makes you wait
 * for. Measured 2026-09-11 inside a parallel shard: "per-call model and effort
 * reach isolated argv" rejected with "Codex completion timed out" at 2005,58 ms
 * - five milliseconds past the budget, on a branch with no diff at all, and the
 * card (154da512) spent a round chasing a red that was never its own.
 *
 * DERIVED FROM BOTH ENDS. Above: the harness allows 30 s per test
 * (`--timeout ${TOPICS_TEST_TIMEOUT_MS:-30000}`) and the heaviest of these
 * cases spawns twice, so two budgets plus the assertions must stay inside it.
 * Below: the observed contention peak is just over 2 s. Ten seconds is five
 * times that peak and still leaves a third of the harness budget unused, so a
 * process that never answers is still red - with the provider's own message,
 * which says more than "test timed out".
 */
const SPAWN_BUDGET_MS = 10_000;

describe('Codex completion with a fake executable', () => {
  test('per-call model and effort reach isolated argv without mutating defaults', async () => {
    const provider = new CodexProvider({ type: 'codex', model: 'configured-model', defaultWorkspace: root });
    const result = await provider.complete([{ role: 'user', content: 'classify' }], { model: 'gpt-5.6-luna', reasoningEffort: 'low', isolated: true, timeoutMs: SPAWN_BUDGET_MS });
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
    await expectGone(run.pid);
    expect(existsSync(run.cwd)).toBe(false);
  });

  test('timeout also kills a wrapper native child holding inherited output pipes', async () => {
    const provider = new CodexProvider({ type: 'codex', defaultWorkspace: root });
    const started = Date.now();
    await expect(provider.complete([{ role: 'user', content: 'wrapper' }], { isolated: true, timeoutMs: 2000 })).rejects.toThrow('timed out');
    const run = JSON.parse(readFileSync(marker, 'utf8'));
    expect(Date.now() - started).toBeLessThan(4500);
    await expectGone(run.wrapper);
    await expectGone(run.pid);
    expect(existsSync(run.cwd)).toBe(false);
  });

  test('Claude classification honors per-call model/effort and has no enabled tools', async () => {
    const provider = new ClaudeCodeProvider({ type: 'claude-code', defaultWorkspace: root });
    const result = await provider.complete([{ role: 'user', content: 'classify' }], { model: 'claude-haiku-4-5', reasoningEffort: 'low', timeoutMs: SPAWN_BUDGET_MS });
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
    await expectGone(run.wrapper);
    await expectGone(run.pid);
  });
});
