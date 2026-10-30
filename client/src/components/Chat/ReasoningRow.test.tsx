/**
 * The reasoning row is in its final place from the first moment of the turn:
 * partial (even with no text yet) and final render it at the same position,
 * above the answer, so the end of the turn inserts nothing over the text.
 *
 * @covers USAGE-20
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageContent } from '../MessageContent';

const render = (partial: boolean, thinking: string) =>
  renderToStaticMarkup(
    <MessageContent
      role="assistant"
      content="The answer"
      partial={partial}
      blocks={[
        { kind: 'thinking', text: thinking },
        { kind: 'text', text: 'The answer' },
      ]}
      messageId="m1"
    />,
  );

describe('ReasoningRow across partial and final', () => {
  test('the row is above the answer both while partial (even empty) and when final', () => {
    for (const html of [render(true, ''), render(true, 'abc'), render(false, 'abc')]) {
      const row = html.indexOf('data-testid="reasoning-row"');
      expect(row).toBeGreaterThan(-1);
      expect(row).toBeLessThan(html.indexOf('The answer'));
    }
  });
  test('a final message with no reasoning draws no row', () => {
    expect(render(false, '')).not.toContain('reasoning-row');
  });
});
