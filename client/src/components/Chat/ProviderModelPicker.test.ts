/**
 * @covers CHAT-DEF-03, MSEL-04
 *
 * The chat chip's text when the choice runs through Topics: the «Topics» pill
 * is already drawn next to it, so the text must not say «via Topics» again.
 *
 * Rendered in a child process with the snapshot hook mocked there, so the mock
 * cannot outlive this file (`mock.module` is not retracted by `mock.restore`).
 * No browser: `renderToStaticMarkup`.
 */
import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

function chip(topicsRouting: boolean) {
  const script = `
    import { mock } from 'bun:test';
    const at = '2026-10-02T00:00:00Z';
    const entry = (name, label, models) => ({ name, label, status: 'ready', isDefault: name === 'claude-code', models, capabilities: ['coding-tasks'], requirements: [], fetchedAt: at });
    const snapshot = { providers: [entry('claude-code', 'Claude Code', ['claude-opus-5-5']), entry('topics', 'Topics', ['claude-opus-5-5'])], defaultProvider: 'claude-code', generatedAt: at };
    mock.module(${JSON.stringify(resolve(import.meta.dir, '../../hooks/useProvidersSnapshot.ts'))}, () => ({
      useProvidersSnapshot: () => ({ snapshot, loading: false, error: null, refresh: async () => {}, retry: async () => {} }),
    }));
    const React = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { ProviderModelPicker } = await import(${JSON.stringify(resolve(import.meta.dir, 'ProviderModelPicker.tsx'))});
    const markup = renderToStaticMarkup(React.createElement(ProviderModelPicker, {
      override: { provider: 'claude-code', model: 'claude-opus-5-5' }, onChange: () => {}, topicsRouting: ${topicsRouting},
    }));
    const label = />([^<]*)<\\/span><svg/.exec(markup.slice(markup.indexOf('provider-model-picker-label')))?.[1] ?? null;
    process.stdout.write(JSON.stringify({ label, pill: markup.includes('data-testid="model-route-mark"') }));
  `;
  const child = Bun.spawnSync([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe', cwd: resolve(import.meta.dir, '../../..') });
  expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
  return JSON.parse(new TextDecoder().decode(child.stdout)) as { label: string | null; pill: boolean };
}

test('with the «Topics» chip lit the trigger text does not repeat «via Topics»', () => {
  expect(chip(true)).toEqual({ label: 'Opus 5.5', pill: true });
});

test('without the chip the trigger still names the engine', () => {
  expect(chip(false)).toEqual({ label: 'Opus 5.5 · via Claude Code', pill: false });
});
