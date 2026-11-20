/**
 * A CHANGE OF ACTION KEEPS THE SAME LOADER, SO THE SQUARES CAN SLIDE.
 *
 * The transformation lives in the body the canvas effect creates (`LoaderBody`):
 * a loader that remounted on a change of action would start the new shape from
 * a fresh body, grown out of the centre, and the slide from the old shape would
 * never be seen. The harness has no DOM, but the canvas's `ref` is the
 * component's own `useRef` object: the same object on every pass means the same
 * component instance, a new one means a remount.
 *
 * @covers LAYOUT-33
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { ReactElement } from 'react';
import { mount } from '../../test/reactHarness';
import { signalsActions, useSignalsStore } from '../../state/signals';
import { attentionActions, useAttentionStore } from '../../state/attention';
import { __resetAgentActions, agentActionActions, useAgentActionStore, ACTION_DWELL_MS } from '../../state/agentActions';
import { TopicsProvider } from '../../contexts/TopicsContext';
import { ProjectStreamingSpinner, TopicStreamingSpinner } from './StreamingIndicator';
import type { AgentAction } from '../../../../shared/agent-action';
import type { Topic } from '../../types';

// The harness reads zustand's initial state on the server path: point it at the live one.
(useSignalsStore as unknown as { getInitialState: unknown }).getInitialState = useSignalsStore.getState;
(useAttentionStore as unknown as { getInitialState: unknown }).getInitialState = useAttentionStore.getState;
(useAgentActionStore as unknown as { getInitialState: unknown }).getInitialState = useAgentActionStore.getState;

const topic = { id: 't1', name: 'Revisione', projectPath: '/p' } as unknown as Topic;
const TURN: AgentAction[] = ['think', 'read', 'run', 'write', 'web', 'edit', 'wait'];

beforeEach(() => {
  attentionActions.reset();
  __resetAgentActions();
  signalsActions.setLiveStreamTopics(new Set(['t1']));
});
afterEach(() => {
  signalsActions.setLiveStreamTopics(new Set());
  __resetAgentActions();
});

/** Plays a turn through the action store and returns the distinct canvas refs and the loader states seen. */
function playTurn(el: ReactElement): { refs: Set<unknown>; canvases: number } {
  const h = mount(<TopicsProvider topics={{ t1: topic }} terminalSessions={[]}>{el}</TopicsProvider>);
  const refs = new Set<unknown>();
  let canvases = 0;
  const read = () => {
    const found = h.last().hosts.filter((n) => n.type === 'canvas');
    canvases = Math.max(canvases, found.length);
    for (const c of found) refs.add(c.props.ref);
  };
  let now = Date.now();
  for (const action of TURN) {
    // Past the dwell, so every action really becomes the shown one.
    now += ACTION_DWELL_MS + 1;
    agentActionActions.note('t1', action, now);
    h.rerender();
    read();
  }
  h.unmount();
  return { refs, canvases };
}

const surfaces: Array<[string, ReactElement]> = [
  ['the chat tab (compact)', <TopicStreamingSpinner topicId="t1" />],
  ['the sidebar chat row (labeled)', <TopicStreamingSpinner topicId="t1" variant="labeled" lastActivity={Date.now()} quiet />],
  ['the project row', <ProjectStreamingSpinner projectPath="/p" />],
];

for (const [name, el] of surfaces) {
  test(`${name}: one loader for the whole turn, never remounted by a change of action`, () => {
    const { refs, canvases } = playTurn(el);
    expect(canvases).toBe(1);
    expect(refs.size).toBe(1);
  });
}

test('the action store really moved through the turn (the test is not watching a still loader)', () => {
  let now = Date.now();
  const seen: (AgentAction | undefined)[] = [];
  for (const action of TURN) {
    now += ACTION_DWELL_MS + 1;
    agentActionActions.note('t1', action, now);
    seen.push(useAgentActionStore.getState().actions.get('t1')?.action);
  }
  expect(seen).toEqual(TURN);
});
