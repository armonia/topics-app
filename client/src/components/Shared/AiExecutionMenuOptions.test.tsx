/**
 * @covers AICTRL-01
 *
 * THE ROUTING SWITCH NEVER LIES ABOUT WHAT IT CAN DO.
 *
 * The row lives above the execution list in every surface that shows this
 * menu (`AiExecutionMenuOptions.tsx`). Two things are checked here, neither
 * held up by the compiler:
 *
 * 1. A routable pinned provider (Claude, served by the native engine) keeps
 *    the switch live, and toggling it never rewrites `value` — the pinned
 *    provider/model is a target, not something the switch itself edits.
 * 2. A non-routable pinned provider (Codex: no native path, see
 *    `shared/task-coding-models.ts#isRoutableThroughTopics`) keeps the row
 *    VISIBLE but DISABLED, with a non-empty reason readable in its title and
 *    an "unavailable" badge next to it — AICTRL-01's "never a silent no-op"
 *    at the UI layer, mirroring the backend block already covered in
 *    `server/routes/chat.provider-selection.test.ts`.
 *
 * (jsdom/happy-dom are deliberately not dependencies of this project, so the
 * mount is `renderToStaticMarkup`, same as `TaskModelMenuOptions.test.tsx`.)
 */
import { describe, test, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AiExecutionMenuOptions } from './AiExecutionMenuOptions';
import { selectedModelMissingIn } from './aiExecutionSelection';
import type { ProvidersSnapshot } from '../../types';

const ROUTABLE_SNAPSHOT: ProvidersSnapshot = {
  defaultProvider: 'topics',
  generatedAt: '2026-09-22T00:00:00Z',
  providers: [
    { name: 'topics', label: 'Topics', status: 'ready', isDefault: true, models: ['claude-sonnet-5'], capabilities: ['coding-tasks'], requirements: [], fetchedAt: '2026-09-22T00:00:00Z' },
    { name: 'claude-code', label: 'Claude Code', status: 'ready', isDefault: false, models: ['claude-sonnet-5'], capabilities: ['coding-tasks'], requirements: [], fetchedAt: '2026-09-22T00:00:00Z' },
  ],
};

const NON_ROUTABLE_SNAPSHOT: ProvidersSnapshot = {
  ...ROUTABLE_SNAPSHOT,
  providers: [
    ...ROUTABLE_SNAPSHOT.providers,
    { name: 'codex', label: 'Codex', status: 'ready', isDefault: false, models: ['gpt-5-codex'], capabilities: ['coding-tasks'], requirements: [], fetchedAt: '2026-09-22T00:00:00Z' },
  ],
};

/** The routing row's own markup, `null` when the switch was not rendered at all. */
function routingRow(markup: string): { title: string; disabled: boolean; checked: boolean; hasUnavailableBadge: boolean } | null {
  const match = markup.match(/<button[^>]*data-testid="ai-selector-topics-routing"[^>]*>.*?<\/button>/s);
  if (!match) return null;
  const html = match[0];
  const title = /title="([^"]*)"/.exec(html)?.[1] ?? '';
  return {
    title,
    disabled: /\sdisabled(=""|\s|>)/.test(html),
    checked: /aria-checked="true"/.test(html),
    hasUnavailableBadge: html.includes('Non disponibile'),
  };
}

describe('the AICTRL-01 routing switch', () => {
  test('a routable pinned provider keeps the switch enabled, with the always-on hint as its title', () => {
    let toggled: boolean | null = null;
    const markup = renderToStaticMarkup(
      <AiExecutionMenuOptions
        snapshot={ROUTABLE_SNAPSHOT}
        surface="chat"
        value={{ provider: 'claude-code', model: 'claude-sonnet-5' }}
        onSelect={() => {}}
        automaticLabel="Auto"
        automaticHint="Auto"
        topicsRouting={{ enabled: true, onToggle: (next) => { toggled = next; } }}
      />,
    );
    const row = routingRow(markup);
    expect(row).not.toBeNull();
    expect(row!.disabled).toBe(false);
    expect(row!.checked).toBe(true);
    expect(row!.title).toBe('Attivo: il turno passa dal motore leggero di Topics, verso il provider e il modello sotto. Spento: esecuzione diretta.');
    expect(row!.hasUnavailableBadge).toBe(false);
    // The toggle handler is wired but never invoked by rendering alone — this
    // asserts the callback exists to flip `enabled`, not `value`.
    expect(toggled).toBeNull();
  });

  test('a non-routable pinned provider (Codex) keeps the switch visible, disabled, with a readable reason and a badge', () => {
    const markup = renderToStaticMarkup(
      <AiExecutionMenuOptions
        snapshot={NON_ROUTABLE_SNAPSHOT}
        surface="chat"
        value={{ provider: 'codex', model: 'gpt-5-codex' }}
        onSelect={() => {}}
        automaticLabel="Auto"
        automaticHint="Auto"
        topicsRouting={{ enabled: false, onToggle: () => {} }}
      />,
    );
    const row = routingRow(markup);
    expect(row).not.toBeNull();
    expect(row!.disabled).toBe(true);
    expect(row!.checked).toBe(false);
    expect(row!.title).toBe('Non instradabile con la selezione attuale.');
    expect(row!.title.length).toBeGreaterThan(0);
    expect(row!.hasUnavailableBadge).toBe(true);
  });

  test('when ON and non-routable the switch stays enabled to click, so the user can still turn it off', () => {
    // AICTRL-01: ON is never trapped. Only OFF + non-routable locks the row —
    // otherwise a pinned selection that later became incompatible would leave
    // the user stuck with no way to switch it off from this menu.
    const markup = renderToStaticMarkup(
      <AiExecutionMenuOptions
        snapshot={NON_ROUTABLE_SNAPSHOT}
        surface="chat"
        value={{ provider: 'codex', model: 'gpt-5-codex' }}
        onSelect={() => {}}
        automaticLabel="Auto"
        automaticHint="Auto"
        topicsRouting={{ enabled: true, onToggle: () => {} }}
      />,
    );
    const row = routingRow(markup);
    expect(row!.disabled).toBe(false);
    expect(row!.checked).toBe(true);
  });

  test('omitting topicsRouting renders no switch at all, on either menu panel', () => {
    const runtimes = renderToStaticMarkup(
      <AiExecutionMenuOptions
        snapshot={ROUTABLE_SNAPSHOT}
        surface="chat"
        value={{ provider: null, model: null }}
        onSelect={() => {}}
        automaticLabel="Auto"
        automaticHint="Auto"
      />,
    );
    expect(routingRow(runtimes)).toBeNull();
  });
});

// Drilling into a provider listed the model picked on ANOTHER one as
// "unavailable" (seen in WebKit: Claude Code / Sonnet 5 selected, drill-in on
// Codex or Gemini). The selection belongs to its own provider panel.
describe('the selected model belongs to its own provider panel only', () => {
  const codex = { name: 'codex', status: 'ready' as const, models: ['gpt-5.5'] };
  test('another provider panel does not claim the selection as missing', () => {
    expect(selectedModelMissingIn(codex, { provider: 'claude-code', model: 'claude-sonnet-5' })).toBe(false);
  });
  test('the owning panel still flags a model it no longer lists', () => {
    expect(selectedModelMissingIn(codex, { provider: 'codex', model: 'gpt-4' })).toBe(true);
  });
  test('a model with no provider (legacy pin) is judged against the open panel', () => {
    expect(selectedModelMissingIn(codex, { provider: null, model: 'gpt-4' })).toBe(true);
  });
});
