/**
 * resolveCodexReasoningEffort() — mirror of the resolveClaudeEffort() contract:
 * explicit override → mirror env → user config.toml → default; unrecognised
 * values resolve to null (no override passed, no badge shown).
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCodexReasoningEffort } from './topics-agent-prompt';

const ENV_KEYS = ['TOPICS_CODEX_REASONING_EFFORT', 'CODEX_REASONING_EFFORT'] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

const fixtureDir = mkdtempSync(join(tmpdir(), 'codex-effort-test-'));
/** Path that never exists — forces the "no config" branch. */
const missingConfig = join(fixtureDir, 'nope', 'config.toml');

function writeConfig(contents: string): string {
  const p = join(fixtureDir, `config-${Math.random().toString(36).slice(2)}.toml`);
  writeFileSync(p, contents);
  return p;
}

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe('resolveCodexReasoningEffort', () => {
  test('explicit Topics override wins over everything', () => {
    process.env.TOPICS_CODEX_REASONING_EFFORT = 'medium';
    process.env.CODEX_REASONING_EFFORT = 'low';
    const config = writeConfig('model_reasoning_effort = "ultra"\n');
    expect(resolveCodexReasoningEffort({ configPath: config })).toBe('medium');
  });

  test('"off"/"default" disable the override entirely', () => {
    for (const v of ['off', 'default', ' OFF ']) {
      process.env.TOPICS_CODEX_REASONING_EFFORT = v;
      expect(resolveCodexReasoningEffort({ configPath: missingConfig })).toBeNull();
    }
  });

  test('"none" is a real codex tier, NOT a disable keyword', () => {
    process.env.TOPICS_CODEX_REASONING_EFFORT = 'none';
    expect(resolveCodexReasoningEffort({ configPath: missingConfig })).toBe('none');
  });

  test('mirror env is used when no Topics override', () => {
    process.env.CODEX_REASONING_EFFORT = 'HIGH';
    expect(resolveCodexReasoningEffort({ configPath: missingConfig })).toBe('high');
  });

  test('user config.toml value wins over the default (never downgrade)', () => {
    const config = writeConfig('model = "gpt-5.6-sol"\nmodel_reasoning_effort = "ultra"\n');
    expect(resolveCodexReasoningEffort({ configPath: config })).toBe('ultra');
  });

  test('config keys inside a table are ignored (root-level only)', () => {
    const config = writeConfig('[profiles.deep]\nmodel_reasoning_effort = "minimal"\n');
    expect(resolveCodexReasoningEffort({ configPath: config })).toBe('xhigh');
  });

  test('defaults to xhigh with no env and no config', () => {
    expect(resolveCodexReasoningEffort({ configPath: missingConfig })).toBe('xhigh');
  });

  test('unrecognised tier resolves to null (no override passed)', () => {
    process.env.TOPICS_CODEX_REASONING_EFFORT = 'galactic';
    expect(resolveCodexReasoningEffort({ configPath: missingConfig })).toBeNull();
    delete process.env.TOPICS_CODEX_REASONING_EFFORT;
    const config = writeConfig('model_reasoning_effort = "galactic"\n');
    expect(resolveCodexReasoningEffort({ configPath: config })).toBeNull();
  });
});
