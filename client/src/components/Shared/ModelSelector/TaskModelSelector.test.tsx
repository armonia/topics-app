/**
 * @covers MP-TASK-01, KANBAN-80, MSEL-01, MSEL-06, MP-TASK-07, AICTRL-03, AICTRL-04
 *
 * THE CARD SELECTOR IS THE ONE SELECTOR, AND IT NEVER CHOOSES FOR YOU.
 *
 * Moved from `TaskModelMenuOptions.test.tsx` when that adapter became
 * `TaskModelSelector` over `ModelSelector` (tasks 1.6, 4.2). The rows are drawn
 * by `ModelList` with scope `task`; the stored value keeps its check mark,
 * Automatic is a first-class row, a stored model whose provider dropped stays
 * selected and disabled, and the board default is what the band judges for a
 * card on Automatic. The surfaces' wiring is checked on the SOURCE, same
 * method as before: `TaskDetail.tsx` and `KanbanBoardPane.tsx` pull in the
 * API, the pane layout and a dozen stores, so they do not mount here.
 *
 * (jsdom/happy-dom are deliberately not dependencies of this project, so the
 * mount is `renderToStaticMarkup`. Clicking the rows is E2E's job.)
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModelList, type ModelListProps } from './ModelList';
import { taskMenuSelection } from './useModelCatalog';
import { taskModelCatalog } from '../../../hooks/useTaskModelCatalog';
import { CLAUDE_CODE, CODEX_ENTRY, ENGINE, entry, snapshotOf } from './fixtures';
import type { ProvidersSnapshot } from '../../../types';

const here = import.meta.dir;
const board = join(here, '../../Board');
const FLEET = snapshotOf([CLAUDE_CODE, CODEX_ENTRY, ENGINE], 'claude-code');

function draw(value: string | null, props: Partial<ModelListProps> = {}, snapshot: ProvidersSnapshot = FLEET, boardValue?: string | null) {
  return renderToStaticMarkup(
    <ModelList
      scope="task" variant="compact" focusSearch={false} onClose={() => {}} onSelect={() => {}} onOpenProviders={() => {}}
      automatic={{ who: 'segue la board', hint: 'Segue la scelta della board' }} snapshot={snapshot}
      value={taskMenuSelection(value, snapshot)}
      routingTarget={value === null && boardValue ? taskMenuSelection(boardValue, snapshot) : undefined}
      {...props}
    />,
  );
}

/** Every choice of the list as `<model, selected, disabled>`: the rows are
 *  buttons with `aria-pressed` (revision 2026-10-04 §4.7, no listbox). */
function options(markup: string) {
  return [...markup.matchAll(/<button[^>]*data-testid="model-row(?:-automatic(?:-within)?)?"[^>]*>/g)].map((m) => ({
    model: /data-model="([^"]*)"/.exec(m[0])?.[1] ?? (/data-testid="model-row-automatic"/.test(m[0]) ? 'auto' : /data-provider="([^"]*)"/.exec(m[0])?.[1] ?? ''),
    selected: /aria-pressed="true"/.test(m[0]),
    disabled: /aria-disabled="true"|\sdisabled=""/.test(m[0]),
  }));
}

describe('the card rows', () => {
  test('Automatic comes first and stays selected before anything is chosen', () => {
    const drawn = options(draw(null));
    expect(drawn[0]).toMatchObject({ model: 'auto', selected: true });
  });

  test('only coding engines, «Automatico» within Codex, and never a Topics row (AICTRL-01)', () => {
    const fleet = snapshotOf([CLAUDE_CODE, CODEX_ENTRY, ENGINE, entry('openai', 'OpenAI', ['gpt-api-only'], { capabilities: ['streaming'] })]);
    const markup = draw('codex:gpt-6.1-sol', {}, fleet);
    expect(markup).toMatch(/data-testid="model-row-automatic-within"[^>]*data-provider="codex"/);
    expect(markup).not.toContain('data-model="gpt-api-only"');
    expect(markup).not.toContain('data-provider="topics"');
  });

  test('the check mark sits on the selected model and nowhere else, legacy values included', () => {
    for (const value of ['claude-code:claude-sonnet-5-5', 'claude-sonnet-5-5', 'topics:claude-sonnet-5-5']) {
      expect(options(draw(value)).filter((o) => o.selected).map((o) => o.model)).toEqual(['claude-sonnet-5-5']);
    }
  });

  test('a stored model whose provider went down remains selected and disabled, never falls back to Auto', () => {
    const down = snapshotOf([{ ...CLAUDE_CODE, status: 'unavailable', lastError: 'Sign in required', models: [] }, CODEX_ENTRY]);
    const markup = draw('claude-code:claude-opus-5-5', {}, down);
    const drawn = options(markup);
    expect(drawn.filter((o) => o.selected)).toEqual([{ model: 'claude-opus-5-5', selected: true, disabled: true }]);
    expect(markup).toContain('data-testid="model-row-settings"');
    expect(markup).toContain('data-testid="ai-selector-providers"');
  });

  test('a write in flight locks every row, Auto included', () => {
    const drawn = options(draw('codex:gpt-6.1-sol', { disabled: true }));
    expect(drawn.length).toBeGreaterThan(3);
    expect(drawn.every((o) => o.disabled)).toBe(true);
  });

  test('jcode offers manual models but no runtime automatic choice', () => {
    const jcode = snapshotOf([entry('jcode', 'jcode', ['claude-opus-5-5'])], 'jcode');
    const markup = draw('jcode:claude-opus-5-5', {}, jcode);
    expect(markup).toContain('data-model="claude-opus-5-5"');
    expect(markup).not.toMatch(/data-testid="model-row-automatic-within"[^>]*data-provider="jcode"/);
  });
});

describe('MSEL-06 on a card: the band judges the board default and never blocks', () => {
  const band = (markup: string) => /data-testid="model-selector-routing"[^>]*data-route="([a-z]+)"/.exec(markup)?.[1];
  test('a card on Automatic over a Codex board default, switch ON: direct, and the switch stays clickable', () => {
    const markup = draw(null, { topicsRouting: { enabled: true, onToggle: () => {} } }, FLEET, 'codex:gpt-6.1-sol');
    expect(band(markup)).toBe('direct');
    expect(markup).toContain('Codex non passa da Topics');
    expect(/data-testid="model-selector-routing"[^>]*\sdisabled/.test(markup)).toBe(false);
  });
  test('a card on Automatic over a Claude board default the engine serves: via Topics', () => {
    expect(band(draw(null, { topicsRouting: { enabled: true, onToggle: () => {} } }, FLEET, 'claude-code:claude-opus-5-5'))).toBe('topics');
  });
  test('a model chosen on the card is judged on its own, not on the board default', () => {
    expect(band(draw('codex:gpt-6.1-sol', { topicsRouting: { enabled: true, onToggle: () => {} } }, FLEET, 'claude-code:claude-opus-5-5'))).toBe('direct');
  });
  test('OFF reads off', () => {
    expect(band(draw('claude-code:claude-opus-5-5', { topicsRouting: { enabled: false, onToggle: () => {} } }))).toBe('off');
  });
});

describe('the catalog of a stored value (KANBAN-80)', () => {
  test('the catalog lists a stored model once, keeps it when its provider is gone, and adds nothing when none is stored', () => {
    const snapshot = snapshotOf([CODEX_ENTRY]);
    const catalog = taskModelCatalog(snapshot, null);
    expect(taskModelCatalog(snapshot, 'gpt-6.1-sol')).toEqual(catalog);
    expect(taskModelCatalog(snapshot, 'claude-sonnet-4')).toEqual(['claude-sonnet-4', ...catalog]);
    expect(taskModelCatalog(snapshot, 'auto')).toEqual(catalog);
  });
});

describe('the surfaces open the one selector', () => {
  const surfaces = {
    composer: readFileSync(join(board, 'FloatingTaskComposer.tsx'), 'utf8'),
    drawer: readFileSync(join(board, 'TaskDetail.tsx'), 'utf8'),
    settings: readFileSync(join(board, 'BoardSettingsPanel.tsx'), 'utf8'),
    pane: readFileSync(join(board, 'KanbanBoardPane.tsx'), 'utf8'),
  };

  test('composer and drawer use the compact variant, the board settings the full one', () => {
    expect(surfaces.composer).toContain('<TaskModelSelector');
    expect(surfaces.drawer).toContain('<TaskModelSelector');
    expect(surfaces.settings).toContain('<TaskModelSelector');
    expect(surfaces.composer.slice(surfaces.composer.indexOf('<TaskModelSelector'))).toContain('variant="compact"');
    expect(surfaces.drawer.slice(surfaces.drawer.indexOf('<TaskModelSelector'))).toContain('variant="compact"');
    expect(surfaces.settings.slice(surfaces.settings.indexOf('<TaskModelSelector'))).toContain('variant="full"');
    for (const src of Object.values(surfaces)) {
      expect(src.includes('availableTaskModels')).toBe(false);
      expect(src.includes('subscribeProvidersSnapshot')).toBe(false);
    }
  });

  test('composer and drawer hand the selector the board default an Automatic card inherits', () => {
    expect(surfaces.composer).toContain('boardValue={boardDispatchModel}');
    expect(surfaces.drawer).toContain('boardValue={boardDispatchModel}');
  });

  test('in the all-boards view the drawer reads the card\'s own board and the composer the board it creates on', () => {
    const composer = surfaces.pane.slice(surfaces.pane.indexOf('<FloatingTaskComposer'), surfaces.pane.indexOf('<TaskDetail'));
    const drawer = surfaces.pane.slice(surfaces.pane.indexOf('<TaskDetail'));
    expect(surfaces.pane).toContain('const cardSettings = useCardBoardSettings(selected?.projectId, projectId, settings);');
    expect(drawer).toContain('boardTopicsRoutingDefault={cardSettings?.dispatchTopicsRouting ?? null}');
    expect(drawer).toContain('boardDispatchModel={cardSettings?.dispatchModel ?? null}');
    expect(composer).toContain('global={mode === \'all\'}');
    expect(composer).toContain('paneSettings={settings}');
    expect(surfaces.composer).toContain('useComposerBoardSettings(global, targetProject, projectId, paneSettings)');
  });

  // Revision 2026-10-04 §3.8: one closed format, «label · who», the same
  // function on every card surface (AC-30).
  test('the chips keep their test hooks and label the STORED model in the one closed format', () => {
    expect(surfaces.composer).toContain('data-testid="composer-model-chip"');
    expect(surfaces.drawer).toContain('data-testid="task-model-chip"');
    expect(surfaces.composer).toContain('useTaskModelTrigger(model, composerRouting, \'task\', boardDispatchModel)');
    expect(surfaces.drawer).toContain('useTaskModelTrigger(task?.model || null, drawerRouting, \'task\', boardDispatchModel)');
    expect(surfaces.settings).toContain('useTaskModelTrigger(s?.dispatchModel ?? null');
    for (const src of [surfaces.composer, surfaces.drawer, surfaces.settings]) expect(src).toContain('{modelTrigger.line}'.replace('modelTrigger', src === surfaces.settings ? 'boardTrigger' : 'modelTrigger'));
  });
});
