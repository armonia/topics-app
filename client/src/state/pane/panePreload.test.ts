/**
 * Which chunks a reload warms: the panes of the store, and the tiles the
 * project windows persisted in their own local records.
 *
 * @covers PERF-02
 */
import { describe, expect, test } from 'bun:test';
import { paneTypesToWarm } from './panePreload';
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
