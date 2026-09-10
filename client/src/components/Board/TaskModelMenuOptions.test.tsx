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

const here = import.meta.dir;
const CATALOG = ['claude-opus-5', 'claude-sonnet-5', 'codex:o4-mini'];

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
  rows(renderToStaticMarkup(<TaskModelMenuOptions {...props} />));

describe('the task model rows', () => {
  test('Auto comes first, then one friendly label per available model', () => {
    const drawn = draw({ models: CATALOG, value: null, onSelect: () => {}, autoLabel: 'Auto' });
    expect(drawn.map((r) => r.label)).toEqual(['Auto', 'Opus 5', 'Sonnet 5', 'o4-mini · Codex']);
  });

  test('an empty catalog still offers Auto, because the server picks it', () => {
    const drawn = draw({ models: [], value: null, onSelect: () => {}, autoLabel: 'Automatico' });
    expect(drawn.map((r) => r.label)).toEqual(['Automatico']);
    expect(drawn[0].selected).toBe(true);
  });

  test('the check mark sits on the selected model and nowhere else', () => {
    const drawn = draw({ models: CATALOG, value: 'claude-sonnet-5', onSelect: () => {}, autoLabel: 'Auto' });
    expect(drawn.filter((r) => r.selected).map((r) => r.label)).toEqual(['Sonnet 5']);
  });

  test('a stored model whose provider went down selects nothing, and never falls back to Auto', () => {
    // The provider behind `claude-opus-5` disconnected, so the live catalog no
    // longer lists it. The task still runs on it.
    const drawn = draw({ models: ['claude-sonnet-5'], value: 'claude-opus-5', onSelect: () => {}, autoLabel: 'Auto' });
    expect(drawn.map((r) => r.label)).toEqual(['Auto', 'Sonnet 5']);
    expect(drawn.filter((r) => r.selected)).toEqual([]);
  });

  test('a write in flight locks every row, Auto included', () => {
    const drawn = draw({ models: CATALOG, value: null, onSelect: () => {}, disabled: true, autoLabel: 'Auto' });
    expect(drawn).toHaveLength(4);
    expect(drawn.every((r) => r.disabled)).toBe(true);
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
    expect(composer).not.toContain('lucide-sparkles');
    expect(drawer).toContain('lucide-sparkles');
    expect(drawer).not.toContain('title=');
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
      expect(src).toContain('useTaskModelCatalog()');
      expect(src.includes('availableTaskModels')).toBe(false);
      expect(src.includes('subscribeProvidersSnapshot')).toBe(false);
    });
  }

  test('composer and drawer draw the shared rows instead of their own copy', () => {
    expect(surfaces.composer).toContain('<TaskModelMenuOptions');
    expect(surfaces.drawer).toContain('<TaskModelMenuOptions');
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
