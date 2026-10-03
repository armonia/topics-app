/**
 * @covers AICTRL-01, AICTRL-02, MSEL-01, MSEL-02, MSEL-04, MSEL-07
 *
 * THE BODY OF THE ONE SELECTOR, ON THE CATALOG MEASURED ON 2026-10-02.
 *
 * Moved from `AiExecutionMenuOptions.test.tsx` (tasks 1.6): the routing switch
 * became the Run-in-Topics band, and the two levels (engine, then model)
 * became one panel with a section per company. What is checked here is what
 * the compiler cannot hold: the band never blocks and always says the route,
 * Opus and GPT are in the same panel without a click, the older generations
 * fold, the GPT windows are the declared ones, and a provider that is not
 * ready stays visible with its reason and a way out.
 *
 * (jsdom/happy-dom are deliberately not dependencies of this project, so the
 * mount is `renderToStaticMarkup`. Keyboard and layout are E2E's job,
 * `tests/e2e/model-selector.spec.ts`.)
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModelList, type ModelListProps } from './ModelList';
import { CLAUDE_CODE, CODEX_ENTRY, MEASURED, entry, snapshotOf } from './fixtures';
import type { ProvidersSnapshot } from '../../../types';

function draw(props: Partial<ModelListProps> = {}, snapshot: ProvidersSnapshot = MEASURED) {
  return renderToStaticMarkup(
    <ModelList
      scope="chat" variant="compact" layout="list" focusSearch={false} onClose={() => {}} onSelect={() => {}}
      automatic={{ label: 'Torna al default', hint: 'Default: Claude Code' }} snapshot={snapshot}
      value={{ provider: null, model: null }}
      {...props}
    />,
  );
}
const band = (markup: string) => {
  const m = /<button[^>]*data-testid="model-selector-routing"[^>]*>.*?<\/button>/s.exec(markup)?.[0] ?? '';
  return {
    present: !!m,
    route: /data-route="([a-z]+)"/.exec(m)?.[1],
    checked: /aria-checked="true"/.test(m),
    disabled: /\sdisabled(=""|\s|>)/.test(m),
    line: /data-testid="model-selector-routing-line"[^>]*>([^<]*)</.exec(m)?.[1] ?? '',
  };
};
const rowOf = (markup: string, model: string) => new RegExp(`<div[^>]*data-model="${model.replace(/[.[\]]/g, '\\$&')}"[^>]*>.*?</div>`, 's').exec(markup)?.[0] ?? '';

describe('«Esegui in Topics» (MSEL-07)', () => {
  test('on, with a model the engine serves: the band is lit and explains in a line', () => {
    const b = band(draw({ value: { provider: 'claude-code', model: 'claude-opus-5-5' }, topicsRouting: { enabled: true, onToggle: () => {} } }));
    expect(b).toMatchObject({ present: true, route: 'topics', checked: true, disabled: false });
    expect(b.line).toBe('Claude gira dentro Topics col tuo abbonamento, senza aprire un processo Claude Code per chat. GPT e Gemini restano diretti.');
  });

  test('on, with GPT-6.1-Sol: the band says it goes direct and why, and stays clickable', () => {
    const b = band(draw({ value: { provider: 'codex', model: 'gpt-6.1-sol' }, topicsRouting: { enabled: true, onToggle: () => {} } }));
    expect(b).toMatchObject({ route: 'direct', checked: true, disabled: false });
    expect(b.line).toBe('Questo modello va diretto: Codex non passa da Topics.');
  });

  test('the line never promises the same quota nor less memory', () => {
    const b = band(draw({ topicsRouting: { enabled: false, onToggle: () => {} } }));
    expect(b.route).toBe('off');
    expect(b.line.toLowerCase()).not.toMatch(/quota|memoria|memory/);
  });

  test('without the prop there is no band (the default model of one provider)', () => {
    expect(band(draw()).present).toBe(false);
  });
});

describe('every company in one view (MSEL-02, AICTRL-02)', () => {
  test('Opus 5.5 and GPT-6.1-Sol are both in the panel, with no Topics row', () => {
    const markup = draw();
    expect(rowOf(markup, 'claude-opus-5-5')).toContain('Opus 5.5');
    expect(rowOf(markup, 'gpt-6.1-sol')).toContain('GPT-6.1-Sol');
    expect(markup).not.toContain('data-provider="topics"');
    expect(markup).toContain('data-testid="model-section-anthropic"');
    expect(markup).toContain('data-testid="model-section-openai"');
  });

  test('gpt-5.5 is folded under «Altri modelli (4)», and comes back selected when it is the value', () => {
    const markup = draw();
    expect(rowOf(markup, 'gpt-5.5')).toBe('');
    expect(markup).toContain('Altri modelli (4)');
    const chosen = draw({ value: { provider: 'codex', model: 'gpt-5.5' } });
    expect(rowOf(chosen, 'gpt-5.5')).toContain('aria-selected="true"');
    expect(rowOf(chosen, 'gpt-5.5')).toContain('Si ritira il 14/10');
  });

  test('the [1m] variant is a toggle inside the row, not a row', () => {
    const markup = draw();
    expect(markup).not.toContain('data-model="claude-opus-5-5[1m]"');
    expect(rowOf(markup, 'claude-opus-5-5')).toContain('data-testid="model-row-1m"');
  });

  test('a provider that is not ready stays visible with its reason', () => {
    const markup = draw({}, snapshotOf([CLAUDE_CODE, entry('codex', 'Codex', [], { status: 'unavailable', lastError: 'Sign in required' })]));
    expect(markup).toContain('data-testid="model-section-not-ready"');
    expect(markup).toContain('Sign in required');
  });

  test('the layout is declared on the panel: columns from 720px, a list below', () => {
    expect(draw({ layout: 'columns' })).toContain('data-layout="columns"');
    expect(draw()).toContain('data-layout="list"');
  });
});

describe('each row helps to choose (MSEL-04)', () => {
  test('the GPT rows show the declared 272K, never the table\'s 400K or ≈1M', () => {
    const row = rowOf(draw(), 'gpt-6.1-sol');
    expect(row).toContain('data-context-tokens="272000"');
    expect(row).toContain('272K');
  });

  test('the route is written on the row', () => {
    const markup = draw({ topicsRouting: { enabled: true, onToggle: () => {} } });
    expect(rowOf(markup, 'claude-opus-5-5')).toContain('via Topics');
    expect(rowOf(markup, 'gpt-6.1-sol')).toContain('via Codex');
  });

  test('the full variant shows the description, the compact one does not', () => {
    expect(rowOf(draw({ variant: 'full' }), 'gpt-6.1-sol')).toContain('Latest workhorse model for coding and everyday work.');
    expect(rowOf(draw(), 'gpt-6.1-sol')).not.toContain('Latest workhorse model');
  });
});

describe('a disabled selector writes nothing and offers nothing (MP-TASK-07)', () => {
  test('the engine «via» toggle and the recovery action are disabled with the rows', () => {
    // Opus 5.5 served by two engines (the toggle), and a stored model no
    // longer in the catalog (the recovery action).
    const twoEngines = snapshotOf([CLAUDE_CODE, CODEX_ENTRY, entry('anthropic-api', 'Anthropic API', ['claude-opus-5-5'])]);
    const markup = draw({ disabled: true, value: { provider: 'codex', model: 'gpt-retired-1' } }, twoEngines);
    const buttons = (testId: string) => [...markup.matchAll(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`, 'g'))].map((m) => m[0]);
    const via = buttons('model-row-via');
    const recovery = buttons('model-row-settings');
    expect(via.length).toBeGreaterThan(0);
    expect(recovery.length).toBe(1);
    for (const button of [...via, ...recovery]) expect(button).toMatch(/\sdisabled(=""|\s|>)/);
  });
});

describe('the chat surfaces open the one selector (MSEL-01)', () => {
  const read = (path: string) => readFileSync(join(import.meta.dir, path), 'utf8');
  test('the composer, the chat settings and the provider default all use ModelSelector', () => {
    expect(read('../../Chat/ProviderModelPicker.tsx')).toContain('variant="compact"');
    const settings = read('../../Modals/TopicSettingsModal.tsx');
    expect(settings).toContain('<ModelSelector');
    expect(settings).toContain('variant="full"');
    expect(settings).not.toContain('<Select');
    expect(read('../../Settings/ProviderDefaultModel.tsx')).toContain('onlyProvider={provider}');
  });
});

