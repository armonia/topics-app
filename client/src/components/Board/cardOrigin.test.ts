/**
 * Whose work a card is and which channel it came from: the rules the filter bar, the chip and the grouping share.
 * @covers KANBAN-05
 */
import { describe, expect, test } from 'bun:test';
import { CHANNEL_SEPARATOR as S, NO_CHANNEL, cardOwner, channelPath, channelTree, countOwners, matchesChannels, type OwnerTask } from './cardOrigin';

const card = (over: Partial<OwnerTask> = {}): OwnerTask => ({ createdBy: null, scheduled: undefined, assignedTo: null, channel: undefined, openerAgent: undefined, openerTopicId: undefined, ...over });
const ME = 'Attilio Rossi';
const discord = (over = {}) => ({ topicId: 'c1', name: '#lancio', kind: 'discord' as const, place: { server: 'Armonia', channel: 'lancio' }, ...over });

describe('cardOwner', () => {
  test('a schedule wins over everything', () => {
    expect(cardOwner(card({ createdBy: 'cron:main-ci', assignedTo: 'Jarvis' }), ME).key).toBe('scheduled');
    expect(cardOwner(card({ scheduled: { by: 'Jarvis', at: null }, createdBy: 'human' }), ME).key).toBe('scheduled');
  });

  test('the assignee names the agent or the person', () => {
    expect(cardOwner(card({ createdBy: 'agent:api', assignedTo: 'Jarvis' }), ME).key).toBe('agent:jarvis');
    expect(cardOwner(card({ createdBy: 'agent:api', assignedTo: 'Visione' }), ME).key).toBe('agent:gtm');
    expect(cardOwner(card({ createdBy: 'agent:api', assignedTo: 'Attilio' }), ME).key).toBe('me');
    expect(cardOwner(card({ createdBy: 'agent:api', assignedTo: 'Attilio Rossi' }), ME).key).toBe('me');
  });

  test("an agent's chat or channel makes it that agent's card", () => {
    expect(cardOwner(card({ createdBy: 'agent:session', openerTopicId: 't', openerAgent: 'gtm' }), ME).key).toBe('agent:gtm');
    expect(cardOwner(card({ createdBy: 'agent:api', channel: discord({ agent: 'jarvis' }) }), ME).key).toBe('agent:jarvis');
    // A channel chat with nothing else to say is the main agent's.
    expect(cardOwner(card({ channel: discord() }), ME).key).toBe('agent:jarvis');
  });

  test("a person's card is theirs; a named agent's is that agent's", () => {
    expect(cardOwner(card({ createdBy: 'human' }), ME).key).toBe('me');
    expect(cardOwner(card({ createdBy: 'agent:jarvis' }), ME).key).toBe('agent:jarvis');
    expect(cardOwner(card({ createdBy: 'agent:nightly-review' }), ME).key).toBe('agent:nightly-review');
  });

  test('a chat session, else the board', () => {
    expect(cardOwner(card({ createdBy: 'agent:session', openerTopicId: 't' }), ME).key).toBe('session');
    expect(cardOwner(card({ createdBy: 'agent:coordinator' }), ME).key).toBe('session');
    expect(cardOwner(card({ createdBy: 'agent:api', assignedTo: 'agente' }), ME).key).toBe('board');
    expect(cardOwner(card(), ME).key).toBe('board');
  });

  test('without the person name an assignee is not guessed', () => {
    expect(cardOwner(card({ createdBy: 'agent:api', assignedTo: 'Attilio' }), null).key).toBe('board');
  });

  test('counts are exclusive and ordered: you, board, agents (main first), sessions, schedules', () => {
    const counts = countOwners([
      card({ createdBy: 'cron:x' }), card({ createdBy: 'agent:session', openerTopicId: 't' }),
      card({ assignedTo: 'Visione' }), card({ assignedTo: 'Jarvis' }), card({ assignedTo: 'Jarvis' }),
      card(), card({ createdBy: 'human' }),
    ], ME);
    expect(counts).toEqual([
      { key: 'me', count: 1 }, { key: 'board', count: 1 }, { key: 'agent:jarvis', count: 2 },
      { key: 'agent:gtm', count: 1 }, { key: 'session', count: 1 }, { key: 'scheduled', count: 1 },
    ]);
  });
});

describe('channels', () => {
  const thread = card({ channel: discord({ place: { server: 'Armonia', channel: 'lancio', thread: 'Video' } }) });
  const group = card({ channel: { topicId: 'w', name: 'Gruppo Studio', kind: 'whatsapp' } });
  const none = card();

  test('the path is kind, then the place, or the chat name when the place is unknown', () => {
    expect(channelPath(thread)).toEqual(['discord', 'Armonia', 'lancio', 'Video']);
    expect(channelPath(group)).toEqual(['whatsapp', 'Gruppo Studio']);
    expect(channelPath(none)).toBeNull();
  });

  test('a selected level lets through everything under it', () => {
    expect(matchesChannels(thread, ['discord'])).toBe(true);
    expect(matchesChannels(thread, [`discord${S}Armonia${S}lancio`])).toBe(true);
    expect(matchesChannels(thread, [`discord${S}Armonia${S}altro`])).toBe(false);
    expect(matchesChannels(group, ['discord'])).toBe(false);
    expect(matchesChannels(none, [NO_CHANNEL])).toBe(true);
    expect(matchesChannels(none, ['discord'])).toBe(false);
    expect(matchesChannels(none, [])).toBe(true);
  });

  test('the tree counts every level', () => {
    const tree = channelTree([thread, thread, group, none]);
    expect(tree.map((n) => [n.label, n.count])).toEqual([['discord', 2], ['whatsapp', 1]]);
    expect(tree[0]!.children[0]!.children[0]!.children[0]).toMatchObject({ label: 'Video', depth: 3, count: 2 });
  });
});
