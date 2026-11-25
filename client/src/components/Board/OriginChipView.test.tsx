/**
 * The owner chip on the card and in the drawer, the incomplete line, and the
 * origin filters (owner, channel, «My work») they share a rule with.
 * @covers KANBAN-01
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { incompleteChip } from './createdByLabel';
import { initialBoardFilters, isPreset, taskMatchesFilters } from './taskFilter';
import type { BoardTask } from '../../lib/board';
import { MY_WORK_PRESET, NO_FILTERS, type BoardFilters } from './constants';
import { IncompleteChipView } from './IncompleteChipView';
import { OriginChipView } from './OriginChipView';
import { ownerChip } from './ownerChip';

// The chip must go through the single in-app door (it checks the chat exists), so the door is injected.
const routed: unknown[] = [];
const notified: string[] = [];
const fakeDoor = ((target: unknown, opts?: { notify?: (m: string) => void }) => {
  routed.push(target);
  opts?.notify?.('gone');
}) as never;

const tr = (key: string, params?: Record<string, string | number>) =>
  `${key}${params ? JSON.stringify(params) : ''}`;
const ME = 'Ada Lovelace';

function task(over: Partial<BoardTask>): BoardTask {
  return { id: 't', text: 'x', status: 'review', priority: 2, projectId: 'p', labels: [], ...over } as BoardTask;
}

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

describe('owner chip', () => {
  test('the person and the board are an icon with the sentence in the tooltip', () => {
    for (const t of [task({ createdBy: 'human' }), task({ createdBy: 'agent:api' })]) {
      const chip = ownerChip(t, tr, ME);
      expect(chip.label).toBe('');
      const html = renderToStaticMarkup(<OriginChipView chip={chip} />);
      expect(html).toContain('<svg');
      expect(html).toContain(`data-owner="${chip.key}"`);
    }
  });

  test('an agent carries its name: Jarvis in the accent, Visione in violet', () => {
    const jarvis = ownerChip(task({ assignedTo: 'Jarvis' }), tr, ME);
    expect(jarvis).toMatchObject({ key: 'agent:jarvis', label: 'Jarvis' });
    expect(renderToStaticMarkup(<OriginChipView chip={jarvis} />)).toContain('bg-blue-600');
    const agentCard = ownerChip(task({ openerAgent: 'gtm', createdBy: 'agent:session', openerTopicId: 'v1' }), tr, ME);
    expect(agentCard).toMatchObject({ key: 'agent:gtm', label: 'Visione', openTopicId: 'v1' });
    const html = renderToStaticMarkup(<OriginChipView chip={agentCard} />);
    expect(html).toContain('bg-violet-600');
    expect(html).toContain('>Visione<');
  });

  test('a chat session names its chat; a schedule says so and who set it', () => {
    const session = ownerChip(task({ createdBy: 'agent:session', openerTopicId: 's1', openerName: 'Riunione clienti' }), tr, ME);
    expect(session).toMatchObject({ kind: 'session', label: 'Riunione clienti', openTopicId: 's1' });
    const cron = ownerChip(task({ createdBy: 'cron:nightly' }), tr, ME);
    expect(cron.kind).toBe('scheduled');
    expect(cron.title).toContain('nightly');
  });

  test('clicking a chat-backed owner opens the chat through openTabInApp, with no bare link', () => {
    const chip = ownerChip(task({ createdBy: 'agent:session', openerName: 'Riunione', openerTopicId: 'top-1' }), tr, ME);
    let stopped = false;
    const tree = OriginChipView({ chip, open: fakeDoor, notify: (m) => { notified.push(m); } });
    const button = find(tree, (el) => el.props['data-testid'] === 'card-origin')!;
    button.props.onClick({ stopPropagation: () => { stopped = true; } });
    expect(routed).toEqual([{ kind: 'chat', key: 'top-1' }]);
    expect(stopped).toBe(true);
    expect(notified).toEqual(['gone']);
    expect(renderToStaticMarkup(tree)).not.toContain('href');
  });

  test('without a chat behind it the chip is not a button', () => {
    const html = renderToStaticMarkup(<OriginChipView chip={ownerChip(task({ createdBy: 'cron:x' }), tr, ME)} />);
    expect(html).not.toContain('<button');
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

describe('origin filters', () => {
  const mine = task({ createdBy: 'human', status: 'review' });
  const board = task({ createdBy: 'agent:api' });
  const running = task({ createdBy: 'human', status: 'in_progress' });
  const jarvis = task({ createdBy: 'agent:api', channel: { topicId: 'c', name: '#lancio', kind: 'discord', place: { server: 'Armonia', channel: 'lancio' } } });
  const chat = task({ createdBy: 'agent:session', openerTopicId: 's' });
  const cron = task({ createdBy: 'cron:nightly' });
  const all = [mine, board, running, jarvis, chat, cron];
  const pass = (f: Partial<BoardFilters>) => all.map((t) => taskMatchesFilters(t, { ...NO_FILTERS, ...f }, { personName: ME }));

  test('«My work» keeps the person and the board, and hides what is running', () => {
    expect(pass({ owners: [...MY_WORK_PRESET.owners], hideInProgress: true })).toEqual([true, true, false, false, false, false]);
    expect(isPreset({ ...NO_FILTERS, owners: ['board', 'me'], hideInProgress: true }, MY_WORK_PRESET)).toBe(true);
    expect(isPreset({ ...NO_FILTERS, owners: ['me'], hideInProgress: true }, MY_WORK_PRESET)).toBe(false);
  });

  test('one owner, one channel, and nothing chosen lets everything through', () => {
    expect(pass({ owners: ['agent:jarvis'] })).toEqual([false, false, false, true, false, false]);
    expect(pass({ channels: ['discord'] })).toEqual([false, false, false, true, false, false]);
    expect(pass({})).toEqual([true, true, true, true, true, true]);
  });

  test('a board opens on its own saved filters, else on the last preset picked, «My work» the first time', () => {
    expect(initialBoardFilters(null, null)).toMatchObject({ owners: ['me', 'board'], hideInProgress: true });
    expect(initialBoardFilters(null, 'all')).toMatchObject({ owners: [], hideInProgress: false });
    // Saved before the origin axes: the text stays, the preset is added once.
    expect(initialBoardFilters(JSON.stringify({ text: 'login' }), null)).toMatchObject({ text: 'login', owners: ['me', 'board'] });
    // Saved after: exactly what the person left.
    expect(initialBoardFilters(JSON.stringify({ v: 2, owners: ['agent:gtm'], hideInProgress: false }), 'mine')).toMatchObject({ owners: ['agent:gtm'], hideInProgress: false });
    expect(initialBoardFilters('{broken', null).owners).toEqual(['me', 'board']);
  });

  test('«Needs you» keeps only what waits on the person', () => {
    const asks = task({ createdBy: 'agent:api', status: 'todo', humanAsk: 'ok?' } as Partial<BoardTask>);
    const queued = task({ createdBy: 'agent:api', status: 'todo' });
    expect(taskMatchesFilters(asks, { ...NO_FILTERS, needsMe: true }, { personName: ME })).toBe(true);
    expect(taskMatchesFilters(queued, { ...NO_FILTERS, needsMe: true }, { personName: ME })).toBe(false);
  });
});
