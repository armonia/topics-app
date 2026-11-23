/**
 * The turn a user's turn-end hook asked for is drawn as ONE service line with
 * the hook's first line, never as the person's bubble.
 * @covers HOOKS-04
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { HookNudgeLine } from './HookNudgeLine';
import { hookNudgeOf } from './machineRow';

describe('the hook continuation as a service line', () => {
  test('one line, the label and the first line of the text, the whole text on hover', () => {
    const content = 'Run the retrospective skill\nthen apply what it finds';
    const nudge = hookNudgeOf([{ kind: 'hook-nudge', attempt: 1 }], content)!;
    const html = renderToStaticMarkup(<HookNudgeLine attempt={nudge.attempt} firstLine={nudge.firstLine} content={content} />);
    expect(html.match(/data-testid="hook-nudge-row"/g)?.length).toBe(1);
    expect(html).toContain('data-hook-nudge="1"');
    expect(html).toContain(': Run the retrospective skill</span>');
    expect(html).not.toContain('then apply what it finds</span>');
    expect(html).toContain('title="Run the retrospective skill');
  });
});
