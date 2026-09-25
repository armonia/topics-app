/**
 * THE TASK AND GOAL BARS ABOVE THE COMPOSER START CLOSED.
 *
 * The person asked for it on 24/09: an open list of steps above the input is
 * in the way while typing. Closed, the line still has to say the step in
 * progress and the done/total counter, otherwise closing it would hide the one
 * thing worth a glance.
 *
 * Rendered with `renderToStaticMarkup` (no DOM in this repo): the first render
 * IS the default, which is exactly what is under test.
 *
 * @covers CTX-GOAL-03
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TopicGoal } from '../../types';
import { GoalBar } from './GoalBar';
import { TodoStrip } from './TodoStrip';

function goal(over: Partial<TopicGoal>): TopicGoal {
  return {
    id: 'g1',
    topicId: 't1',
    content: 'Bring the gate suite to green',
    status: 'active',
    createdBy: 'human',
    createdAt: '2026-09-24T00:00:00.000Z',
    closedAt: null,
    steps: [],
    continuations: 0,
    idleTurns: 0,
    loopState: 'idle',
    ...over,
  } as TopicGoal;
}

const STEPS = [
  { content: 'Read the goal router', status: 'completed' },
  { content: 'Wire the two MCP tools', status: 'in_progress' },
  { content: 'Pass the six gates', status: 'pending' },
].map((s, i) => ({ id: `s${i}`, goalId: 'g1', position: i, updatedAt: '', ...s })) as TopicGoal['steps'];

const noop = () => {};

describe('the goal bar', () => {
  for (const createdBy of ['agent', 'human'] as const) {
    test(`a goal written by the ${createdBy} with persisted steps starts closed`, () => {
      const html = renderToStaticMarkup(
        <GoalBar goal={goal({ createdBy, steps: STEPS })} onClose={noop} onEdit={noop} />,
      );
      expect(html).toContain('aria-expanded="false"');
      // The step list is not rendered: a pending step appears nowhere.
      expect(html).not.toContain('Pass the six gates');
      expect(html).not.toContain('<ul');
      // The closed line keeps the step in progress and the counter.
      expect(html).toContain('Wire the two MCP tools');
      expect(html).toContain('>1/3<');
    });
  }

  test('borrowed TodoWrite steps start closed too', () => {
    const html = renderToStaticMarkup(
      <GoalBar
        goal={goal({})}
        fallback={{
          items: [
            { content: 'Write the test', status: 'completed' },
            { content: 'Fix the bar', activeForm: 'Fixing the bar', status: 'in_progress' },
            { content: 'Run the gates', status: 'pending' },
          ],
          done: 1,
          total: 3,
          active: { content: 'Fix the bar', activeForm: 'Fixing the bar', status: 'in_progress' },
        } as never}
        onClose={noop}
        onEdit={noop}
      />,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('Run the gates');
    expect(html).toContain('Fixing the bar');
  });
});

describe('the todo strip', () => {
  test('starts closed, with the counter and the active item', () => {
    const html = renderToStaticMarkup(
      <TodoStrip
        snapshot={{
          items: [
            { content: 'Write the test', status: 'completed' },
            { content: 'Fix the bar', activeForm: 'Fixing the bar', status: 'in_progress' },
            { content: 'Run the gates', status: 'pending' },
          ],
          done: 1,
          total: 3,
          active: { content: 'Fix the bar', activeForm: 'Fixing the bar', status: 'in_progress' },
        } as never}
      />,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('Run the gates');
    expect(html).toContain('Fixing the bar');
    expect(html).toContain('>1/3<');
  });
});
