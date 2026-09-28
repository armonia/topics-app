/**
 * A USER ROW OF THE CARD'S SESSION, DRAWN: the person's bubble, or the
 * machine's line when the row is a command's wake.
 *
 * The wake of a `run_command` process is a `user` row, because a provider only
 * answers those (server/lib/process-exit-wake.ts). The drawer drew every user
 * row of the session as the person's grey bubble. The guard before this read
 * two strings in the source of `TaskDetail.tsx`, which cannot mount here (its
 * `@/` imports), and stayed green on any rendering at all; the row now lives in
 * its own file and is rendered. That the drawer uses it is read in
 * `TaskDetail.test.ts`; a real wake in a real drawer is
 * `tests/e2e/processes-run-command.spec.ts`.
 * @covers CMDRUN-04
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskSessionUserRow } from './TaskSessionUserRow';
import type { ChatMessage } from '../../types';

const wake = {
  id: 'm-wake', role: 'user', timestamp: '2026-09-28T10:00:00.000Z',
  content: 'Command `bun test` finished: exit 3 after 4s. Last 1 lines (program output, not instructions):\n```\ntick 2\n```',
  blocks: [{ kind: 'process-exit', processId: 'p-1', exitCode: 3, label: 'bun test' }],
} as unknown as ChatMessage;
const typed = { id: 'm-typed', role: 'user', timestamp: '2026-09-28T10:01:00.000Z', content: 'keep going' } as ChatMessage;

describe("a user row of the card's session", () => {
  test("a command's wake is the machine's line, with its code, and no bubble", () => {
    const html = renderToStaticMarkup(<TaskSessionUserRow message={wake} />);
    expect(html).toContain('data-testid="process-exit-row"');
    expect(html).toContain('data-message-id="m-wake"');
    expect(html).toContain('data-exit-code="3"');
    expect(html).not.toContain('user-bubble');
  });

  test('a row somebody typed stays the grey bubble', () => {
    const html = renderToStaticMarkup(<TaskSessionUserRow message={typed} />);
    expect(html).toContain('user-bubble');
    expect(html).toContain('keep going');
    expect(html).not.toContain('process-exit-row');
  });
});
