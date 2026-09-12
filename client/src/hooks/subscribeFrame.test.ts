/**
 * @covers KANBAN-52
 *
 * WHAT THIS WINDOW DECLARES ON THE WIRE, and what it does NOT.
 *
 * Two different sets leave `usePanelLifecycle` on the same trigger, and telling
 * them apart is the whole point:
 *
 *  · `subscribe` decides who receives per-token deltas. It carries the open
 *    panes PLUS whatever a non-pane surface is holding (the task drawer), or
 *    the drawer watches an empty bubble for a whole turn;
 *  · `presence:announce` decides what the OTHER windows draw as "open here".
 *    A drawer reading a session is not a chat open in this window, so it stays
 *    on `presenceTopicIds` alone.
 *
 * The union is pure and exercised for real below. The half that lives inside a
 * hook nobody can mount without the whole app is checked on the SOURCE, same
 * method and same reason as `Board/TaskDetail.test.ts`.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  __resetTopicSubscriptions,
  getExtraTopicIds,
  holdTopic,
  withExtraTopics,
} from '../state/topicSubscriptions';

/** The union exactly as the hook builds it, extras read from the store. */
const declared = (panes: string[]): string[] => withExtraTopics(panes, getExtraTopicIds());

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'usePanelLifecycle.ts'), 'utf8');

/** The one line that sends the subscribe frame, with its argument. */
const subscribeFrame = (() => {
  const i = src.indexOf("type: 'subscribe'");
  return src.slice(src.lastIndexOf('sendWS(', i), src.indexOf('\n', i));
})();

/** The `presence:announce` payload, from its opening to its closing brace. */
const announceFrame = (() => {
  const i = src.indexOf("type: 'presence:announce'");
  return src.slice(i, src.indexOf('});', i));
})();

beforeEach(() => {
  __resetTopicSubscriptions();
});

describe('the subscribe frame', () => {
  test('carries the held topic while it is held, and drops it on release', () => {
    expect(declared(['pane-a'])).toEqual(['pane-a']);

    const release = holdTopic('t1');
    expect(declared(['pane-a'])).toContain('t1');

    release();
    expect(declared(['pane-a'])).not.toContain('t1');
  });

  test('never declares the same topic twice', () => {
    holdTopic('t1');
    expect(declared(['t1', 'pane-a'])).toEqual(['t1', 'pane-a']);
  });

  test('the hook sends the union, not the panes alone', () => {
    expect(subscribeFrame).toContain('subscribedTopicIds');
    expect(subscribeFrame).not.toContain('presenceTopicIds');
    expect(src).toContain('withExtraTopics(presenceTopicIds, extraTopicIds)');
  });

  test('the effect refires when the extra set changes', () => {
    const deps = src.slice(src.indexOf("type: 'subscribe'"));
    expect(deps.slice(0, deps.indexOf('\n\n'))).toContain('subscribedTopicIds');
  });
});

describe('the presence announce', () => {
  test('stays on the open panes: a drawer is not a chat open here', () => {
    expect(announceFrame).toContain('topicIds: presenceTopicIds');
    expect(announceFrame).not.toContain('subscribedTopicIds');
  });
});
