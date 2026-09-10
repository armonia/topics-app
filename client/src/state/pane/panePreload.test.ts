/**
 * Which chunks a reload warms: the panes of the store, and the tiles the
 * project windows persisted in their own local records.
 *
 * @covers PERF-02
 */
import { describe, expect, test } from 'bun:test';
import { paneTypesToWarm, panesOnFirstFrame } from './panePreload';
import type { Pane, PaneState } from './types';
import { DEFAULT_SPACE_ID } from './types';
import { projectPanesKey } from '../../../../shared/project-keys';

const PROJECT = '/Users/someone/Projects/thing';

describe('paneTypesToWarm', () => {
  test('a project window contributes the tiles of its local record', () => {
    const records: Record<string, string> = {
      [projectPanesKey(PROJECT)]: JSON.stringify({
        nonChatPanes: [
          { id: 'term-1', type: 'terminal' },
          { id: 'browser-1', type: 'browser' },
          { id: 'files', type: 'files' },
        ],
      }),
    };
    const types = paneTypesToWarm(
      [{ type: 'project', projectPath: PROJECT }, { type: 'board' }],
      (key) => records[key] ?? null,
    );
    expect(types.sort()).toEqual(['board', 'browser', 'files', 'project', 'terminal']);
  });

  test('a missing or unreadable record warms only the window itself', () => {
    expect(paneTypesToWarm([{ type: 'project', projectPath: PROJECT }], () => null)).toEqual(['project']);
    expect(paneTypesToWarm([{ type: 'project', projectPath: PROJECT }], () => '{not json')).toEqual(['project']);
    expect(paneTypesToWarm([{ type: 'project', projectPath: PROJECT }], () => JSON.stringify({ nonChatPanes: [{ id: 'x' }] }))).toEqual(['project']);
  });

  test('duplicates collapse and a project without a folder reads no record', () => {
    let reads = 0;
    const types = paneTypesToWarm(
      [{ type: 'terminal' }, { type: 'terminal' }, { type: 'project' }],
      () => { reads += 1; return null; },
    );
    expect(types.sort()).toEqual(['project', 'terminal']);
    expect(reads).toBe(0);
  });
});

/**
 * The warm set must not pay for what this window does NOT draw: the pane store
 * is the union of every Spazio and of every window's layout, the first frame
 * shows one of them, and each extra chunk lands inside the first-frame gate's
 * 300 ms cap.
 */
const OTHER_SPACE = 'space:other';

function stateWith(
  panes: Record<string, Pane>,
  order: string[],
  activeSpaceId: string,
  spaces: PaneState['spaces'] = { [OTHER_SPACE]: { id: OTHER_SPACE, name: 'Altro', order: 0, updatedAt: 1 } },
): Parameters<typeof panesOnFirstFrame>[0] {
  return {
    panes,
    groups: {
      'group:default': { id: 'group:default', paneIds: order, splitRatio: 0.5, splitAxis: 'horizontal' },
    },
    spaces,
    activeSpaceId,
  };
}

describe('panesOnFirstFrame', () => {
  const panes: Record<string, Pane> = {
    'board:1': { id: 'board:1', type: 'board' },
    'term:1': { id: 'term:1', type: 'terminal', spaceId: OTHER_SPACE },
    'chat:1': { id: 'chat:1', type: 'chat' },
  };
  const order = ['board:1', 'term:1', 'chat:1'];

  test('una pane di uno Spazio che non stai guardando non si scalda', () => {
    const visible = panesOnFirstFrame(stateWith(panes, order, DEFAULT_SPACE_ID), null);
    expect(visible.map((p) => p.id)).toEqual(['board:1', 'chat:1']);
    // And the converse, which is the half that really matters: switch to the
    // other pane's Spazio and THAT one warms, not the two of the default.
    const other = panesOnFirstFrame(stateWith(panes, order, OTHER_SPACE), null);
    expect(other.map((p) => p.id)).toEqual(['term:1']);
  });

  test('uno Spazio cancellato ricade sul default, come il filtro del render', () => {
    const withDeleted = stateWith(panes, order, DEFAULT_SPACE_ID, {
      [OTHER_SPACE]: { id: OTHER_SPACE, name: 'Altro', order: 0, updatedAt: 1, deleted: true },
    });
    expect(panesOnFirstFrame(withDeleted, null).map((p) => p.id))
      .toEqual(['board:1', 'term:1', 'chat:1']);
  });

  test('una pop-out staccata scalda le SUE chat, non il layout della finestra principale', () => {
    // `?topics=chat:1`: the pop-out draws exactly that id, and there
    // `usePanelLifecycle` bypasses the Spazi filter entirely.
    expect(panesOnFirstFrame(stateWith(panes, order, DEFAULT_SPACE_ID), ['chat:1']).map((p) => p.id))
      .toEqual(['chat:1']);
    // A hosted id the pane store does not know must not take the boot down.
    expect(panesOnFirstFrame(stateWith(panes, order, DEFAULT_SPACE_ID), ['ignoto'])).toEqual([]);
  });

  test('un id nella fila senza record non conta come pane del default', () => {
    const state = stateWith(panes, [...order, 'in-volo'], DEFAULT_SPACE_ID);
    expect(panesOnFirstFrame(state, null).map((p) => p.id)).toEqual(['board:1', 'chat:1']);
  });
});
