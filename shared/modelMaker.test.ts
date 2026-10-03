/** @covers MSEL-02 */
import { describe, expect, test } from 'bun:test';
import { modelMaker } from './modelMaker';

describe('modelMaker: the company from the id prefix (design §3.1)', () => {
  // Ten ids from the catalogs measured on 2026-10-02 (Claude Code, the engine,
  // the Codex cache) plus the shapes the snapshot carries for the others.
  test.each([
    ['claude-opus-5-5', 'anthropic'],
    ['claude-sonnet-5-5[1m]', 'anthropic'],
    ['claude-haiku-4-5-20251001', 'anthropic'],
    ['claude-code:claude-fable-5-1', 'anthropic'],
    ['gpt-6.1-sol', 'openai'],
    ['gpt-5.5', 'openai'],
    ['codex:gpt-6-luna', 'openai'],
    ['o3', 'openai'],
    ['gemini-3-pro', 'google'],
    ['llama-3.3-70b', 'other'],
  ] as const)('%s → %s', (id, maker) => {
    expect(modelMaker(id)).toBe(maker);
  });
});
