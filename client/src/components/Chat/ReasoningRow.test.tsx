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
import { rememberReasoningTranslation, resetReasoningTranslations } from '../../state/reasoningTranslations';

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
  test('the blank lines the model ends its thinking with leave no empty space under the text', () => {
    // Every summarized thinking block arrives ending in "\n\n"; under
    // white-space: pre-wrap those are two empty lines at the bottom of the body.
    // Still thinking (no answer yet), so the body is open.
    const html = renderToStaticMarkup(
      <MessageContent
        role="assistant"
        content=""
        partial
        blocks={[{ kind: 'thinking', text: 'Checking the test first.\n\n' }]}
        messageId="m-trail"
      />,
    );
    expect(html).toContain('data-testid="reasoning-body"');
    expect(html).toMatch(/Checking the test first\.<\/div>/);
  });
  test('a final message with no reasoning draws no row', () => {
    expect(render(false, '')).not.toContain('reasoning-row');
  });

  test('a reserved row between the tools keeps its place when the turn ends', () => {
    // Live: the thinking block opened (empty) before the tool and the answer.
    // Final: the same block now carries its text. Same order, no insertion.
    const tool = { id: 't1', name: 'Bash', args: { command: 'sleep 12' }, status: 'success' as const };
    const withBlocks = (partial: boolean, thinking: string) =>
      renderToStaticMarkup(
        <MessageContent
          role="assistant"
          content="The answer"
          partial={partial}
          toolCalls={[tool]}
          blocks={[
            { kind: 'thinking', text: thinking },
            { kind: 'tool', toolCall: tool },
            { kind: 'text', text: 'The answer' },
          ]}
          messageId="m2"
        />,
      );
    const order = (html: string) => [html.indexOf('reasoning-row'), html.indexOf('tool-call'), html.indexOf('The answer')];
    const live = order(withBlocks(true, ''));
    const final = order(withBlocks(false, 'abc'));
    expect(live[0]).toBeGreaterThan(-1);
    expect(final[0]).toBeGreaterThan(-1);
    expect([...live].sort((a, b) => a - b)).toEqual(live);
    expect([...final].sort((a, b) => a - b)).toEqual(final);
  });

  test('open while the model is thinking, closed once the thinking is over', () => {
    const only = (partial: boolean) =>
      renderToStaticMarkup(
        <MessageContent role="assistant" content="" partial={partial} blocks={[{ kind: 'thinking', text: 'pondering' }]} messageId="m3" />,
      );
    expect(only(true)).toContain('data-testid="reasoning-body"');
    expect(only(true)).toContain('pondering');
    // The answer has started: the reasoning is no longer the live block.
    expect(render(true, 'abc')).not.toContain('reasoning-body');
    expect(render(false, 'abc')).not.toContain('reasoning-body');
  });
});

describe('ReasoningRow with a translation', () => {
  const ONE = 'First I need to read the failing test and see what it expects.';
  const TWO = 'Then I will check the migration file.';

  // The reasoning is the last block and still live, so the row is open and its body drawn.
  const live = (thinking: string) =>
    renderToStaticMarkup(
      <MessageContent role="assistant" content="" partial blocks={[{ kind: 'thinking', text: thinking }]} messageId="m3" />,
    );

  test('with no translation the row is the one it always was: same text, no control', () => {
    resetReasoningTranslations();
    const html = live(`${ONE} ${TWO}`);
    expect(html).toContain(ONE);
    expect(html).not.toContain('reasoning-original-toggle');
    expect(html).not.toContain('data-translated');
  });

  test('a translated sentence replaces its original inside the body, and the control appears', () => {
    resetReasoningTranslations();
    rememberReasoningTranslation(ONE, 'Prima devo leggere il test che fallisce.');
    const html = live(`${ONE} ${TWO}`);
    expect(html).toContain('Prima devo leggere il test che fallisce.');
    expect(html).not.toContain(ONE);
    // The sentence not translated yet stays as the model wrote it.
    expect(html).toContain(TWO);
    expect(html).toContain('data-translated="true"');
    expect(html).toContain('reasoning-original-toggle');
    // The count in the header is the original text's: translating changes no number the row shows.
    expect(html).toContain(`(${(ONE.length + 1 + TWO.length).toLocaleString()} chars)`);
    resetReasoningTranslations();
  });
});
