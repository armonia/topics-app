/** @covers FIRST-RUN-01 */
import { describe, expect, test } from 'bun:test';
import type { ProviderSnapshotEntry } from '../../../../shared/types';
import { firstRunProviderView, shouldShowFirstRun } from './firstRunModel';

const provider = (patch: Partial<ProviderSnapshotEntry> = {}): ProviderSnapshotEntry => ({
  name: 'claude',
  label: 'Claude',
  status: 'ready',
  isDefault: true,
  models: [],
  requirements: [],
  fetchedAt: '2026-10-15T00:00:00.000Z',
  ...patch,
});

describe('first-run decisions', () => {
  test('offers key setup and explains a missing provider when none is registered', () => {
    expect(firstRunProviderView([], 'claude')).toMatchObject({
      provider: null,
      providerName: 'claude',
      status: 'missing',
      ready: false,
      showAnthropicKey: true,
    });
  });

  test('reports why the configured provider is not ready', () => {
    const entry = provider({
      status: 'unavailable',
      requirements: [{ key: 'claude-cli', label: 'Claude CLI', present: false, hint: 'Install Claude Code' }],
    });
    expect(firstRunProviderView([entry], 'claude')).toMatchObject({
      provider: entry,
      status: 'unavailable',
      ready: false,
      showAnthropicKey: true,
      requirements: entry.requirements,
    });
  });

  test('shows a ready configured provider without offering a new key', () => {
    expect(firstRunProviderView([provider()], 'claude')).toMatchObject({
      status: 'ready',
      ready: true,
      showAnthropicKey: false,
    });
  });

  test('shows first run only before completion and while the owner has the placeholder name', () => {
    expect(shouldShowFirstRun(null, 'Proprietario')).toBe(true);
    expect(shouldShowFirstRun('2026-10-15T00:00:00.000Z', 'Proprietario')).toBe(false);
    expect(shouldShowFirstRun(null, 'Ada')).toBe(false);
    expect(shouldShowFirstRun(null, null)).toBe(false);
  });
});
