/**
 * @covers AICTRL-01, AICTRL-02, MSEL-01, MSEL-02, MSEL-04, MSEL-05, MSEL-07, MSEL-08
 *
 * THE BODY OF THE ONE SELECTOR, ON THE CATALOG MEASURED ON 2026-10-02.
 *
 * Moved from `AiExecutionMenuOptions.test.tsx` (tasks 1.6): the routing switch
 * became the Run-in-Topics band, and the two levels (engine, then model)
 * became one panel with a section per company. What is checked here is what
 * the compiler cannot hold: the band never blocks and always says the route,
 * the accordion opens the choice's section (the first with Automatico) and
 * hides the other rows, the older generations fold, the GPT windows are the
 * declared ones, and a provider that is not ready stays visible with its
 * reason and a way out.
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
import { AUDIT_KEYS, AUDIT_NO_KEYS, CLAUDE_CODE, CODEX_ENTRY, MEASURED, entry, snapshotOf } from './fixtures';
import type { ProvidersSnapshot } from '../../../types';

function draw(props: Partial<ModelListProps> = {}, snapshot: ProvidersSnapshot = MEASURED) {
  return renderToStaticMarkup(
    <ModelList
      scope="chat" variant="compact" focusSearch={false} onClose={() => {}} onSelect={() => {}} onOpenProviders={() => {}}
      automatic={{ who: 'Claude Code', hint: 'Usa il predefinito: Claude Code' }} snapshot={snapshot}
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
/** The wrapper of one row: its button, the 1M switch and the recovery action. */
const rowOf = (markup: string, model: string) => new RegExp(`<div[^>]*data-testid="model-row-wrap"[^>]*><button[^>]*data-model="${model.replace(/[.[\]]/g, '\\$&')}"[^>]*>.*?</button>(?:<button[^>]*>.*?</button>)*</div>`, 's').exec(markup)?.[0] ?? '';
/** The accordion toggle of one section, with its expanded state. */
const toggleOf = (markup: string, maker: string) => new RegExp(`data-testid="model-section-${maker}"[\\s\\S]*?data-testid="model-section-toggle"[^>]*>`).exec(markup)?.[0] ?? '';

describe('«Esegui in Topics» (MSEL-07)', () => {
  test('on, with a model the engine serves: the band is lit and explains in a line', () => {
    const b = band(draw({ value: { provider: 'claude-code', model: 'claude-opus-5-5' }, topicsRouting: { enabled: true, onToggle: () => {} } }));
    expect(b).toMatchObject({ present: true, route: 'topics', checked: true, disabled: false });
    // AC-32: the band says everything else goes direct, in one line.
    expect(b.line).toBe('Gli altri vanno diretti.');
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
  test('Automatico opens the first section; the others keep headings only, with no Topics row', () => {
    const markup = draw();
    expect(rowOf(markup, 'claude-opus-5-5')).toContain('Opus 5.5');
    expect(rowOf(markup, 'gpt-6.1-sol')).toBe('');
    expect(markup).not.toContain('data-provider="topics"');
    expect(markup).toContain('data-testid="model-section-anthropic"');
    expect(markup).toContain('data-testid="model-section-openai"');
    expect(toggleOf(markup, 'anthropic')).toContain('aria-expanded="true"');
    expect(toggleOf(markup, 'openai')).toContain('aria-expanded="false"');
  });

  test('a chosen model opens its own section', () => {
    const markup = draw({ value: { provider: 'codex', model: 'gpt-6.1-sol' } });
    expect(rowOf(markup, 'gpt-6.1-sol')).toContain('GPT-6.1-Sol');
    expect(rowOf(markup, 'claude-opus-5-5')).toBe('');
    expect(toggleOf(markup, 'openai')).toContain('aria-expanded="true"');
    expect(toggleOf(markup, 'anthropic')).toContain('aria-expanded="false"');
  });

  test('gpt-5.5 is folded under «Precedenti (4)» once its section opens, and comes back selected when it is the value', () => {
    const codex = draw({ value: { provider: 'codex', model: 'gpt-6.1-sol' } });
    expect(rowOf(codex, 'gpt-5.5')).toBe('');
    expect(codex).toContain('Precedenti (4)');
    expect(toggleOf(draw(), 'openai')).toContain('aria-expanded="false"');
    const chosen = draw({ value: { provider: 'codex', model: 'gpt-5.5' } });
    expect(rowOf(chosen, 'gpt-5.5')).toContain('aria-pressed="true"');
    expect(rowOf(chosen, 'gpt-5.5')).toContain('Si ritira il 14/10');
  });

  test('the [1m] variant is a toggle inside the row, not a row', () => {
    const markup = draw();
    expect(markup).not.toContain('data-model="claude-opus-5-5[1m]"');
    expect(rowOf(markup, 'claude-opus-5-5')).toContain('data-testid="model-row-1m"');
  });

  test('a provider that is not ready is a connect box with its state and one action, never a shell hint (AC-17)', () => {
    // Provider alone: a model would draw the stale stored row instead of the box.
    const codex = draw({ value: { provider: 'codex', model: null } }, AUDIT_NO_KEYS);
    expect(codex).toContain('data-testid="model-section-connect"');
    expect(codex).toContain('Codex è installato, manca l’accesso.');
    expect(codex).toContain('Codex · Da collegare · abbonamento');
    expect(codex).toMatch(/data-testid="model-connect-action"[^>]*data-provider="codex"[^>]*data-action="signIn"[^>]*>Accedi</);
    expect(codex).toContain('data-testid="model-connect-hide"');
    const gemini = draw({ value: { provider: 'gemini', model: null } }, AUDIT_NO_KEYS);
    expect(gemini).toMatch(/data-provider="gemini"[^>]*data-action="setUp"[^>]*>Configura ›</);
    for (const markup of [codex, gemini]) {
      const text = markup.replace(/<[^>]+>/g, ' ');
      for (const word of ['login', 'export', 'ECONNREFUSED']) expect(text).not.toMatch(new RegExp(`(^|[^\\p{L}])${word}([^\\p{L}]|$)`, 'iu'));
      expect(markup).not.toContain('model-connect-direct-lmstudio');
      expect(markup).not.toContain('model-connect-openai');
    }
  });

  test('a provider alone opens its section, even through a connect box', () => {
    const markup = draw({ value: { provider: 'codex', model: null } }, AUDIT_NO_KEYS);
    expect(toggleOf(markup, 'openai')).toContain('aria-expanded="true"');
    expect(markup).toContain('data-testid="model-section-connect"');
  });

  test('the list layout is declared on the panel', () => {
    expect(draw()).toContain('data-layout="list"');
  });
});

describe('each row helps to choose (MSEL-04)', () => {
  test('the GPT rows show the declared 272K, never the table\'s 400K', () => {
    const row = rowOf(draw({ value: { provider: 'codex', model: 'gpt-6.1-sol' } }), 'gpt-6.1-sol');
    expect(row).toContain('data-context-tokens="272000"');
    expect(row).toContain('272K');
  });

  test('no window is guessed: a row with no known window shows no number (AC-12)', () => {
    const markup = draw({ value: { provider: 'direct-ollama', model: 'qwen3-coder:30b' } }, snapshotOf([CLAUDE_CODE, entry('direct-ollama', 'Ollama', ['qwen3-coder:30b'], { capabilities: ['streaming'] })]));
    expect(markup).not.toContain('≈');
    expect(markup).toContain('data-model="qwen3-coder:30b"');
    expect(rowOf(markup, 'qwen3-coder:30b')).not.toContain('data-context-tokens');
  });

  test('the engine is written in the heading; a row says «via X» only when it runs elsewhere (AC-13, AC-14)', () => {
    const anthropic = draw({ value: { provider: 'claude-code', model: 'claude-opus-5-5' }, topicsRouting: { enabled: true, onToggle: () => {} } }, AUDIT_KEYS);
    expect(rowOf(anthropic, 'claude-opus-5-5')).not.toContain('data-testid="model-row-via"');
    // The accessible name carries the engine and the route.
    expect(rowOf(anthropic, 'claude-opus-5-5')).toMatch(/aria-label="Opus 5.5, 200K, Claude Code, via Topics"/);
    const codexMarkup = draw({ value: { provider: 'codex', model: 'gpt-6.1-sol' }, topicsRouting: { enabled: true, onToggle: () => {} } }, AUDIT_KEYS);
    expect(rowOf(codexMarkup, 'o4-mini')).toContain('via OpenAI API');
    const section = (maker: string) => new RegExp(`data-testid="model-section-${maker}".*?data-testid="model-section-heading".*?</div>`, 's').exec(anthropic)?.[0] ?? '';
    expect(section('anthropic')).toContain('via Topics');
    expect(section('anthropic')).toContain('data-testid="model-group-engine"');
    expect(section('deepseek')).toContain('via Ollama (Mac mini)');
    expect(section('deepseek')).not.toContain('data-testid="model-group-engine"');
  });

  test('no catch-all group, and every group names a company (AC-01)', () => {
    const markup = draw({}, AUDIT_KEYS);
    expect(markup).not.toContain('model-section-other');
    const makers = [...markup.matchAll(/data-testid="model-section-([^"]+)" data-maker="([^"]+)"/g)].map((m) => [m[1], m[2]]);
    expect(makers.map((m) => m[1])).toEqual(['anthropic', 'openai', 'google', 'meta', 'deepseek', 'mistral', 'qwen', 'xai']);
    for (const [testId, maker] of makers) expect(testId).toBe(maker);
    const headings = [...markup.matchAll(/id="model-group-[^"]+"[^>]*>([^<]+)</g)].map((m) => m[1]!);
    for (const heading of headings) expect(heading).not.toMatch(/(^|[^\p{L}])(Altri|Altro|Other|Others|Varie|Misc|Endpoint|Endpoints|Agenti|Agents|API|Locali|Local)([^\p{L}]|$)/iu);
  });

  test('the body is not a listbox, and no button holds another (axe: nested-interactive, aria-required-children)', () => {
    const markup = draw({}, AUDIT_KEYS);
    expect(markup).not.toContain('role="listbox"');
    expect(markup).not.toContain('role="option"');
    // A <button> opened and closed before the next one opens.
    let depth = 0;
    for (const tag of markup.matchAll(/<(\/?)button\b/g)) {
      depth += tag[1] ? -1 : 1;
      expect(depth).toBeLessThanOrEqual(1);
    }
  });

  test('labels stop at two lines and keep the whole name in the title (AC-11)', () => {
    const row = rowOf(draw(), 'claude-opus-5-5');
    expect(row).toContain('title="Opus 5.5"');
    expect(row).toMatch(/class="line-clamp-2[^"]*"[^>]*data-testid="model-row-label"/);
  });

  test('the full variant shows the description, the compact one does not', () => {
    const value = { value: { provider: 'codex', model: 'gpt-6.1-sol' } } as const;
    expect(rowOf(draw({ variant: 'full', ...value }), 'gpt-6.1-sol')).toContain('Latest workhorse model for coding and everyday work.');
    expect(rowOf(draw(value), 'gpt-6.1-sol')).not.toContain('Latest workhorse model');
  });
});

describe('a disabled selector writes nothing and offers nothing (MP-TASK-07)', () => {
  test('the rows and the recovery action are disabled together', () => {
    // A stored model no longer in the catalog (the recovery action).
    const twoEngines = snapshotOf([CLAUDE_CODE, CODEX_ENTRY, entry('anthropic-api', 'Anthropic API', ['claude-opus-5-5'])]);
    const markup = draw({ disabled: true, value: { provider: 'codex', model: 'gpt-retired-1' } }, twoEngines);
    const buttons = (testId: string) => [...markup.matchAll(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`, 'g'))].map((m) => m[0]);
    const rows = buttons('model-row');
    const recovery = buttons('model-row-settings');
    expect(rows.length).toBeGreaterThan(3);
    expect(recovery.length).toBe(1);
    for (const button of [...rows, ...recovery]) expect(button).toMatch(/\sdisabled(=""|\s|>)/);
  });
});

describe('Automatic and the footer (revision §3.7, §4.1)', () => {
  test('«Automatico · Claude Code» names who decides, the long sentence in aria-describedby', () => {
    const markup = draw();
    expect(markup).toMatch(/data-testid="model-row-automatic"[^>]*>.*?Automatico · Claude Code/s);
    expect(markup).toMatch(/aria-describedby="(model-auto-hint-[^"]+)"[^>]*data-testid="model-row-automatic"/);
  });
  test('compact hides the long sentence except on coarse pointers; full shows it', () => {
    expect(draw()).toMatch(/model-row-automatic.*?id="model-auto-hint-[^"]*"[^>]*class="sr-only coarse:not-sr-only[^"]*"[^>]*>Usa il predefinito: Claude Code/s);
    expect(draw()).toMatch(/aria-describedby="(model-auto-hint-[^"]+)"[^>]*data-testid="model-row-automatic"/);
    expect(draw({ variant: 'full' })).toMatch(/model-row-automatic.*?id="model-auto-hint-[^"]*"[^>]*class="block text-mini[^"]*"[^>]*>Usa il predefinito: Claude Code/s);
  });
  test('the footer counts the providers: 9 ready, 1 error (AC-22)', () => {
    expect(draw({}, AUDIT_KEYS)).toMatch(/data-testid="ai-selector-providers-tail"[^>]*>9 pronti · 1 errore</);
  });
});

describe('the chat surfaces open the one selector (MSEL-01)', () => {
  const read = (path: string) => readFileSync(join(import.meta.dir, path), 'utf8');
  test('the composer and the chat settings use ModelSelector', () => {
    expect(read('../../Chat/ProviderModelPicker.tsx')).toContain('variant="compact"');
    const settings = read('../../Modals/TopicSettingsModal.tsx');
    expect(settings).toContain('<ModelSelector');
    expect(settings).toContain('variant="full"');
    expect(settings).not.toContain('<Select');
  });
  test('the provider default is a list in line, from the same catalog, with no second selector (revision §5.5)', () => {
    const inline = read('../../Settings/ProviderDefaultModel.tsx');
    expect(inline).toContain('buildModelCatalog(');
    expect(inline).toContain('onlyProvider: provider');
    expect(inline).not.toContain('<ModelSelector');
  });
});

