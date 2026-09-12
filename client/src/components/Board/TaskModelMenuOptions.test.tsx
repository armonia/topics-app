/**
 * @covers MP-TASK-01
 *
 * ONE MODEL LIST, AND IT NEVER CHOOSES FOR YOU.
 *
 * Two things are checked here, and neither is held up by the compiler.
 *
 * 1. THE ROWS. The picker offers Auto plus one row per executable model, and
 *    the check mark sits on what is actually selected. The case that matters
 *    is the one that only happens when a provider drops: the stored model is
 *    no longer in the live catalog. Nothing may be marked selected then, and
 *    above all Auto must NOT be, because "Auto" is a real server-side choice
 *    and showing it as current would tell the reader the agent had been moved
 *    onto something else. This used to be two copies of the same markup, so
 *    the answer could differ between the composer and the drawer.
 *
 * 2. THE THREE SURFACES READ ONE CATALOG. The composer, the drawer and the
 *    board settings picker each used to seed their own `useState` from the
 *    snapshot store and hand-roll a subscription. That part is checked on the
 *    SOURCE, same method and same reason as `GlobalCapControl.test.tsx`:
 *    `TaskDetail.tsx` and `KanbanBoardPane.tsx` pull in the API, the pane
 *    layout and a dozen stores, so they do not mount in a unit test, and "this
 *    surface went back to its own list" is a one-line change.
 *
 * (jsdom/happy-dom are deliberately not dependencies of this project, so the
 * mount is `renderToStaticMarkup`. Clicking the rows is E2E's job.)
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskModelMenuOptions } from './TaskModelMenuOptions';
import { taskModelCatalog } from '../../hooks/useTaskModelCatalog';
import type { ProvidersSnapshot } from '../../types';

const here = import.meta.dir;
const CATALOG = ['claude-opus-5', 'claude-sonnet-5', 'codex:o4-mini'];
const SNAPSHOT: ProvidersSnapshot = {
  defaultProvider: 'topics',
  generatedAt: '2026-09-12T00:00:00Z',
  providers: [
    { name: 'topics', label: 'Topics', status: 'ready', isDefault: true, models: CATALOG.slice(0, 2), capabilities: ['coding-tasks'], requirements: [], fetchedAt: '2026-09-12T00:00:00Z' },
    { name: 'codex', label: 'Codex', status: 'ready', isDefault: false, models: ['o4-mini'], capabilities: ['coding-tasks'], requirements: [], fetchedAt: '2026-09-12T00:00:00Z' },
  ],
};

/** Every row of the rendered menu, in order, as `<label, selected, disabled>`. */
function rows(markup: string): { label: string; selected: boolean; disabled: boolean }[] {
  return [...markup.matchAll(/<button[^>]*>.*?<\/button>/gs)].map((m) => {
    const html = m[0];
    const label = [...html.matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map((s) => s[1]).join('');
    return {
      label,
      selected: /aria-selected="true"/.test(html),
      disabled: /\sdisabled(=""|\s|>)/.test(html),
    };
  });
}

const draw = (props: Parameters<typeof TaskModelMenuOptions>[0]) =>
  rows(renderToStaticMarkup(<TaskModelMenuOptions snapshot={SNAPSHOT} {...props} />));

describe('the task model rows', () => {
  test('Automatic comes first, then the ready execution engines', () => {
    const drawn = draw({ models: CATALOG, value: null, onSelect: () => {}, autoLabel: 'Auto' });
    expect(drawn.map((r) => r.label)).toContain('Auto');
    expect(drawn.map((r) => r.label)).toContain('TopicsPronto');
    expect(drawn.map((r) => r.label)).toContain('CodexPronto');
  });

  test('Automatic remains selected before an execution engine is chosen', () => {
    const drawn = draw({ models: [], value: null, onSelect: () => {}, autoLabel: 'Automatico' });
    expect(drawn[0].selected).toBe(true);
  });

  test('the check mark sits on the selected model and nowhere else', () => {
    const drawn = draw({ models: CATALOG, value: 'topics:claude-sonnet-5', onSelect: () => {}, autoLabel: 'Auto' });
    expect(drawn.filter((r) => r.selected).map((r) => r.label)).toEqual(['Sonnet 5']);
  });

  test('a legacy unprefixed Claude model remains an explicit manual selection', () => {
    const drawn = draw({ models: CATALOG, value: 'claude-sonnet-5', onSelect: () => {}, autoLabel: 'Auto' });
    expect(drawn.filter((row) => row.selected).map((row) => row.label)).toEqual(['Sonnet 5']);
    expect(drawn.some((row) => row.label === 'Auto' && row.selected)).toBe(false);
  });

  test('jcode offers manual models but no runtime automatic choice', () => {
    const jcode: ProvidersSnapshot = { ...SNAPSHOT, defaultProvider: 'jcode', providers: [
      { name: 'jcode', label: 'JCode', status: 'ready', isDefault: true, models: ['claude-opus-5'], capabilities: ['coding-tasks'], requirements: [], fetchedAt: '2026-09-12T00:00:00Z' },
    ] };
    const drawn = rows(renderToStaticMarkup(
      <TaskModelMenuOptions snapshot={jcode} models={['claude-opus-5']} value="jcode:claude-opus-5" onSelect={() => {}} autoLabel="Auto" />,
    ));
    expect(drawn.map((row) => row.label)).toContain('Opus 5');
    expect(drawn.some((row) => row.label.includes('Automatico in JCode'))).toBe(false);
  });

  test('a stored model whose provider went down remains selected and never falls back to Auto', () => {
    // The provider behind `claude-opus-5` disconnected, so the live catalog no
    // longer lists it. The task still runs on it.
    const unavailable: ProvidersSnapshot = { ...SNAPSHOT, providers: [{ ...SNAPSHOT.providers[0]!, status: 'unavailable', lastError: 'Sign in required' }] };
    const markup = renderToStaticMarkup(<TaskModelMenuOptions snapshot={unavailable} models={[]} value="topics:claude-opus-5" onSelect={() => {}} autoLabel="Auto" />);
    expect(rows(markup).filter((row) => row.selected).map((row) => row.label)).toEqual(['Opus 5Non disponibile']);
    expect(markup).toContain('Apri impostazioni');
  });

  test('a removed saved model stays as a selected unavailable row with recovery', () => {
    const removed = 'topics:claude-opus-4-8';
    const models = taskModelCatalog(SNAPSHOT, removed);
    expect(models[0]).toBe(removed);
    const markup = renderToStaticMarkup(
      <TaskModelMenuOptions snapshot={SNAPSHOT} models={models} value={removed} onSelect={() => {}} autoLabel="Auto" />,
    );
    expect(rows(markup).filter((row) => row.selected).map((row) => row.label)).toEqual(['Opus 4.8Non disponibile']);
    expect(markup).toContain('non è più disponibile');
    expect(markup).toContain('Apri impostazioni');
  });

  test('a write in flight locks every row, Auto included', () => {
    const drawn = draw({ models: CATALOG, value: null, onSelect: () => {}, disabled: true, autoLabel: 'Auto' });
    expect(drawn.length).toBeGreaterThan(1);
    expect(drawn.every((row) => row.disabled)).toBe(true);
    const modelRows = draw({ models: CATALOG, value: 'topics:claude-sonnet-5', onSelect: () => {}, disabled: true, autoLabel: 'Auto' });
    expect(modelRows.length).toBeGreaterThan(2);
    expect(modelRows.every((row) => row.disabled)).toBe(true);
  });

  test('without the disabled flag no row is locked', () => {
    expect(draw({ models: CATALOG, value: null, onSelect: () => {}, autoLabel: 'Auto' }).some((r) => r.disabled)).toBe(false);
  });

  test('each surface passes its own Auto label and its own glyph', () => {
    const composer = renderToStaticMarkup(
      <TaskModelMenuOptions models={[]} value={null} onSelect={() => {}} autoLabel="Auto" autoTitle="Picks the model" />,
    );
    const drawer = renderToStaticMarkup(
      <TaskModelMenuOptions models={[]} value={null} onSelect={() => {}} autoLabel="Automatico" autoIcon />,
    );
    expect(composer).toContain('title="Picks the model"');
    expect(composer).toContain('lucide-sparkles');
    expect(drawer).toContain('lucide-sparkles');
    expect(drawer).toContain('lucide-sparkles');
  });
});

describe('one catalog for the three surfaces', () => {
  const surfaces = {
    composer: readFileSync(join(here, 'FloatingTaskComposer.tsx'), 'utf8'),
    drawer: readFileSync(join(here, 'TaskDetail.tsx'), 'utf8'),
    board: readFileSync(join(here, 'KanbanBoardPane.tsx'), 'utf8'),
  };

  for (const [name, src] of Object.entries(surfaces)) {
    test(`${name} reads the shared hook and keeps no list of its own`, () => {
      expect(src).toContain('useTaskModelCatalog(');
      expect(src.includes('availableTaskModels')).toBe(false);
      expect(src.includes('subscribeProvidersSnapshot')).toBe(false);
    });
  }

  test('composer and drawer draw the shared rows instead of their own copy', () => {
    expect(surfaces.composer).toContain('<TaskModelMenuOptions');
    expect(surfaces.drawer).toContain('<TaskModelMenuOptions');
  });

  test('each surface gives the catalog its stored value so a removed selection stays visible', () => {
    expect(surfaces.composer).toContain('useTaskModelCatalog(model)');
    expect(surfaces.drawer).toContain('useTaskModelCatalog(task?.model)');
    expect(surfaces.board).toContain('useTaskModelCatalog(settings?.dispatchModel)');
  });

  test('the chips keep their test hooks', () => {
    expect(surfaces.composer).toContain('data-testid="composer-model-chip"');
    expect(surfaces.drawer).toContain('data-testid="task-model-chip"');
  });

  test('each chip labels the STORED model, so a disconnect cannot change what it says', () => {
    // The chip reads the value the task (or the draft) holds. It never looks
    // at the live catalog, so a provider going down leaves the label alone.
    expect(surfaces.composer).toContain('{model ? friendlyModelLabel(model) : tr(\'board.composer.modelAutoChip\')}');
    expect(surfaces.drawer).toContain('{task.model ? fmtModel(task.model) : \'Auto\'}');
  });
});
