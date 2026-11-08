/**
 * The compact card in review keeps a pending question and its quick replies
 * together: the sentence and the buttons that answer it, never one without the
 * other.
 *
 * Mounted with `renderToStaticMarkup` (no DOM library in this project).
 *
 * @covers KANBAN-106
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { CompactQuestion } from './CompactQuestion';

describe('CompactQuestion', () => {
  test('shows the question and one button per reply', () => {
    const html = renderToStaticMarkup(
      <CompactQuestion question="Procedo con **la migrazione**?" options={['Si', 'No', 'Dopo']} busy={false} onAnswer={() => {}} />,
    );
    expect(html).toContain('data-testid="card-compact-question"');
    expect(html).toContain('Procedo con la migrazione?');
    expect(html.match(/data-testid="card-compact-reply"/g)?.length).toBe(3);
    expect(html).toContain('>Si</button>');
    expect(html).toContain('>Dopo</button>');
  });

  test('a busy card disables the replies but keeps the question', () => {
    const html = renderToStaticMarkup(<CompactQuestion question="Procedo?" options={['Si']} busy onAnswer={() => {}} />);
    expect(html).toContain('Procedo?');
    expect(html).toContain('disabled');
  });

  test('no usable reply: the question is still drawn, with no buttons', () => {
    // A question whose only option is the card's own «land» choice is filtered
    // out of the replies; the card must still say what it is waiting on.
    const html = renderToStaticMarkup(<CompactQuestion question="Fatto: colonna slots. Landa su main?" options={[]} busy={false} onAnswer={() => {}} />);
    expect(html).toContain('data-testid="card-compact-question"');
    expect(html).toContain('Fatto: colonna slots. Landa su main?');
    expect(html).not.toContain('card-compact-reply');
  });

  test('the card draws it for a review card with a pending question, in compact only', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Card.tsx'), 'utf8');
    expect(src).toContain("compact && task.status === 'review' && pending && (");
    expect(src).toContain('<CompactQuestion question={pending.question} options={replyOptions}');
  });
});
