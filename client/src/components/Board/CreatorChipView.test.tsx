/**
 * The creator chip, the incomplete line and the Mine/Others filter (card a7ba2d05).
 * @covers KANBAN-01
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { creatorChip, creatorKind, incompleteChip } from './createdByLabel';
import { CreatorChipView, IncompleteChipView } from './CreatorChipView';
import { taskMatchesFilters } from './taskFilter';
import type { BoardTask } from '../../lib/board';
import type { BoardFilters } from './constants';

const tr = (key: string, params?: Record<string, string | number>) =>
  `${key}${params ? JSON.stringify(params) : ''}`;

const NO_FILTERS: BoardFilters = {
  priority: [], assignedTo: [], text: '', projectId: [], labels: [], person: [], computer: [], initiator: [], runComputer: [],
};

function task(over: Partial<BoardTask>): BoardTask {
  return { id: 't', text: 'x', status: 'review', priority: 2, projectId: 'p', labels: [], ...over } as BoardTask;
}

/** Walks a React element tree and returns the first element matching the predicate. */
type Props = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function find(node: ReactNode, test: (el: ReactElement<Props>) => boolean): ReactElement<Props> | null {
  if (!isValidElement(node)) return null;
  const el = node as ReactElement<Props>;
  if (test(el)) return el;
  const kids = el.props.children;
  for (const kid of Array.isArray(kids) ? kids : [kids]) {
    const hit = find(kid, test);
    if (hit) return hit;
  }
  return null;
}

describe('creator chip', () => {
  test('a person card says «you», an agent card names its chat, the tooltip carries the sentence', () => {
    expect(creatorChip({ createdBy: 'human' }, tr)?.label).toBe('board.card.createdByMe');
    const chip = creatorChip({ createdBy: 'agent:session', createdSource: 'session:s1', openerName: 'Riunione clienti', openerTopicId: 'top-1' }, tr)!;
    expect(chip.label).toBe('Riunione clienti');
    expect(chip.title).toContain('Riunione clienti (session:s1)');
    expect(chip.openTopicId).toBe('top-1');
  });

  test('no author, no chip; the anonymous API caller reads «agent»; the coordinator is never a link', () => {
    expect(creatorChip({ createdBy: null }, tr)).toBeNull();
    expect(creatorChip({ createdBy: 'agent:api' }, tr)?.label).toBe('board.card.createdByApi');
    expect(creatorChip({ createdBy: 'agent:coordinator', openerName: 'Coordinator', openerTopicId: 'g' }, tr)?.openTopicId).toBeNull();
  });

  test('the long name truncates in its own span with min-w-0, so it gets the ellipsis', () => {
    const chip = creatorChip({ createdBy: 'agent:session', openerName: 'Una chat con un nome lunghissimo', openerTopicId: 't' }, tr)!;
    const html = renderToStaticMarkup(<CreatorChipView chip={{ ...chip, openTopicId: null }} />);
    expect(html).toContain('min-w-0 truncate');
    expect(html).toContain('title="');
  });

  test('clicking the chip opens the chat through onOpenTopic, with no bare link', () => {
    const chip = creatorChip({ createdBy: 'agent:session', openerName: 'Riunione', openerTopicId: 'top-1' }, tr)!;
    const opened: string[] = [];
    let stopped = false;
    const tree = CreatorChipView({ chip, onOpenTopic: (id) => opened.push(id) });
    const button = find(tree, (el) => el.props['data-testid'] === 'card-created-by-open')!;
    button.props.onClick({ stopPropagation: () => { stopped = true; } });
    expect(opened).toEqual(['top-1']);
    expect(stopped).toBe(true);
    expect(renderToStaticMarkup(tree)).not.toContain('<a ');
    expect(renderToStaticMarkup(tree)).not.toContain('href');
  });

  test('a chat that no longer exists is plain text, not a button', () => {
    const chip = creatorChip({ createdBy: 'agent:session', openerName: undefined }, tr)!;
    const html = renderToStaticMarkup(<CreatorChipView chip={chip} onOpenTopic={() => {}} />);
    expect(html).not.toContain('card-created-by-open');
  });
});

describe('incomplete line', () => {
  test('shows what is missing on an open card, never on a done one, never when complete', () => {
    const open = incompleteChip({ status: 'review', createdMissing: ['bar', 'source'] }, tr)!;
    expect(open.title).toContain('board.card.missing.bar');
    expect(renderToStaticMarkup(<IncompleteChipView chip={open} />)).toContain('card-incomplete');
    expect(incompleteChip({ status: 'done', createdMissing: ['bar'] }, tr)).toBeNull();
    expect(incompleteChip({ status: 'review' }, tr)).toBeNull();
  });
});

describe('creator filter', () => {
  const mine = task({ createdBy: 'human', status: 'review' });
  const agent = task({ createdBy: 'agent:session' });
  const cron = task({ createdBy: 'cron:nightly' });
  const old = task({ createdBy: null });

  test('Mine keeps a person card even in review; Others keeps agents and schedules; Everyone keeps old cards', () => {
    const pass = (creator: BoardFilters['creator']) => [mine, agent, cron, old].map((t) => taskMatchesFilters(t, { ...NO_FILTERS, creator }));
    expect(pass('mine')).toEqual([true, false, false, false]);
    expect(pass('others')).toEqual([false, true, true, false]);
    expect(pass('all')).toEqual([true, true, true, true]);
    expect(pass(undefined)).toEqual([true, true, true, true]);
  });

  test('creatorKind separates the three', () => {
    expect([creatorKind('human'), creatorKind('agent:x'), creatorKind(null), creatorKind('junk!')]).toEqual(['human', 'other', 'unknown', 'unknown']);
  });
});
